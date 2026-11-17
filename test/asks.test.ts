import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Outbox, type AgentState, type Courier } from "../server/outbox";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";
import { firstExpanded, pillLabel, type Ask } from "../shared/asks";

class FakeCourier implements Courier {
  states = new Map<string, AgentState>();
  sent: { agentId: string; text: string; messageId: string }[] = [];
  failNext = false;
  async state(agentId: string) {
    return this.states.get(agentId) ?? "idle";
  }
  async send(agentId: string, text: string, messageId: string) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("daemon said no");
    }
    this.sent.push({ agentId, text, messageId });
  }
}

const WS = "wks_1";
const AGENT = "agent-1";

describe("asks", () => {
  let dir: string;
  let store: AskStore;
  let courier: FakeCourier;
  let outbox: Outbox;
  let service: AsksService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "asks-"));
    store = new AskStore(dir);
    courier = new FakeCourier();
    outbox = new Outbox(dir, courier, async (deliveries) => {
      for (const delivery of deliveries) if (delivery.askId) await store.update(delivery.workspaceId, delivery.askId, { orphaned: true });
    });
    service = new AsksService(store, outbox, async (agentId) => (agentId === AGENT ? WS : null));
  });

  const decision = {
    kind: "decision",
    title: "Squash-only merges?",
    actions: [
      { label: "a: leave as is", kind: "resolve" },
      { label: "b: squash-only", kind: "resolve", recommended: true },
    ],
  };

  it("numbers asks per workspace and persists them", async () => {
    const first = await service.callTool(AGENT, "ask_create", decision);
    const second = await service.callTool(AGENT, "ask_create", { kind: "followup", title: "File issue for retention switch" });
    expect(first.text).toMatch(/^A1 \[in_progress\] decision/);
    expect(second.text).toMatch(/^A2 /);
    expect(new AskStore(dir).list(WS).map((ask) => ask.id)).toEqual(["A1", "A2"]);
  });

  it("rejects a decision without two options, and a call with no agent id", async () => {
    const bad = await service.callTool(AGENT, "ask_create", { kind: "decision", title: "x" });
    expect(bad.isError).toBe(true);
    expect((await service.callTool(null, "ask_create", decision)).isError).toBe(true);
  });

  it("delivers a human's choice to the owning agent once, and only after its turn ends", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    courier.states.set(AGENT, "running");
    const { ask, delivery } = await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a2", note: "and update AGENTS.md" });
    await outbox.flush();
    expect(ask.status).toBe("done");
    expect(ask.outcome).toMatchObject({ label: "b: squash-only", by: "human" });
    expect(delivery).toBe("queued");
    expect(courier.sent).toEqual([]);

    courier.states.set(AGENT, "idle");
    await outbox.flush(AGENT);
    await outbox.flush(AGENT);
    expect(courier.sent).toHaveLength(1);
    expect(courier.sent[0]!.text).toBe('[asks] A1 (Squash-only merges?) resolved: b: squash-only. Note from the human: "and update AGENTS.md"');
  });

  it("batches several answers into one message", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Retention switch" });
    courier.states.set(AGENT, "running");
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" });
    await service.act({ workspaceId: WS, id: "A2", verb: "drop" });
    courier.states.set(AGENT, "idle");
    await outbox.flush();
    expect(courier.sent).toHaveLength(1);
    expect(courier.sent[0]!.text.split("\n")).toHaveLength(2);
  });

  it("a send action puts the ask in progress until the agent resolves it", async () => {
    await service.callTool(AGENT, "ask_create", {
      kind: "pr",
      title: "PR #30 ready",
      actions: [{ label: "Merge", kind: "send", prompt: "Merge PR #30 with squash" }],
    });
    const { ask } = await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" });
    await outbox.flush();
    expect(ask.status).toBe("in_progress");
    expect(courier.sent[0]!.text).toContain("Merge PR #30 with squash");
    expect(courier.sent[0]!.text).toContain("call ask_resolve for A1");

    await service.callTool(AGENT, "ask_resolve", { id: "A1", note: "merged" });
    expect(store.get(WS, "A1")).toMatchObject({ status: "done", outcome: { by: "agent", note: "merged" } });
    expect(courier.sent).toHaveLength(1);
  });

  it("survives a restart with messages still pending", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    courier.states.set(AGENT, "running");
    await service.act({ workspaceId: WS, id: "A1", verb: "done" });
    const revived = new Outbox(dir, courier);
    courier.states.set(AGENT, "idle");
    await revived.flush();
    expect(courier.sent).toHaveLength(1);
  });

  it("retries a failed send", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    courier.failNext = true;
    await service.act({ workspaceId: WS, id: "A1", verb: "done" }); // its own flush fails
    await outbox.flush();
    expect(courier.sent).toHaveLength(1);
    expect(outbox.pending()).toHaveLength(0);
  });

  it("orphans an open ask whose agent is gone, and stops notifying", async () => {
    await service.callTool(AGENT, "ask_create", { kind: "question", title: "Which region?" });
    courier.states.set(AGENT, "gone");
    await service.act({ workspaceId: WS, id: "A1", verb: "reply", note: "eu-central" });
    await outbox.flush();
    expect(store.get(WS, "A1")?.orphaned).toBe(true);
    expect((await service.act({ workspaceId: WS, id: "A1", verb: "done" })).delivery).toBe("nobody");
  });

  it("a human drop tells the owner and reports it sent when the owner is idle", async () => {
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Merge OK waiting" });
    const { ask, delivery } = await service.act({ workspaceId: WS, id: "A1", verb: "drop" });
    expect(ask.status).toBe("dropped");
    expect(store.get(WS, "A1")?.status).toBe("dropped");
    expect(delivery).toBe("sent");
    expect(courier.sent).toEqual([
      { agentId: AGENT, text: "[asks] A1 (Merge OK waiting) dropped by the human; do not pursue it.", messageId: expect.any(String) },
    ]);
  });

  it("acting on an ask that is already closed fails loudly and tells nobody again", async () => {
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Merge OK waiting" });
    await service.act({ workspaceId: WS, id: "A1", verb: "drop", note: "first" });
    await expect(service.act({ workspaceId: WS, id: "A1", verb: "drop" })).rejects.toThrow("A1 is already dropped");
    await expect(service.act({ workspaceId: WS, id: "A1", verb: "done" })).rejects.toThrow("A1 is already dropped");
    expect(courier.sent).toHaveLength(1);
    expect(store.get(WS, "A1")?.outcome?.note).toBe("first");
  });

  it("the same id in two workspaces names two asks; a drop reaches only the owner in its workspace", async () => {
    const other = new AsksService(store, outbox, async () => "wks_2");
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Merge OK waiting" });
    await other.callTool("agent-2", "ask_create", { kind: "followup", title: "Merge OK in tab" });
    await other.callTool("agent-2", "ask_create", { kind: "question", title: "CoS long replies?" });
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Second here" });
    await service.act({ workspaceId: "wks_2", id: "A2", verb: "drop" });
    expect(courier.sent.map((sent) => sent.agentId)).toEqual(["agent-2"]);
    expect(store.get(WS, "A2")?.status).toBe("in_progress");
  });

  it("lists only open asks by default, and only the caller's with scope mine", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    await service.callTool(AGENT, "ask_create", { kind: "question", title: "Other" });
    await service.callTool(AGENT, "ask_update", { id: "A2", status: "dropped" });
    expect((await service.callTool(AGENT, "ask_list", {})).text).toBe("A1 [in_progress] decision: Squash-only merges?");
    expect((await service.callTool(AGENT, "ask_list", { status: "all" })).text.split("\n")).toHaveLength(2);
  });

  describe("cached PR snapshot when an update changes links", () => {
    const PR_A = "https://github.com/o/r/pull/1";
    const PR_B = "https://github.com/o/r/pull/2";
    const snapshot = { number: 1, url: PR_A, state: "OPEN" as const, isDraft: false, reviewDecision: null, checks: "passing" as const, mergeable: "MERGEABLE", fetchedAt: "2026-11-08T00:00:00.000Z" };
    const withSnapshot = async () => {
      await service.callTool(AGENT, "ask_create", { ...decision, links: [{ label: "PR", url: PR_A }] });
      await store.update(WS, "A1", { pr: snapshot }, { touch: false });
    };

    it("Given a cached PR, When an update removes the PR link, Then the PR snapshot is gone", async () => {
      // Given
      await withSnapshot();
      // When
      await service.callTool(AGENT, "ask_update", { id: "A1", links: [] });
      // Then
      expect(new AskStore(dir).get(WS, "A1")?.pr).toBeUndefined();
    });

    it("Given a cached PR, When an update points the links at another PR, Then the old snapshot is gone", async () => {
      // Given
      await withSnapshot();
      // When
      await service.callTool(AGENT, "ask_update", { id: "A1", links: [{ label: "PR", url: PR_B }] });
      // Then
      expect(new AskStore(dir).get(WS, "A1")?.pr).toBeUndefined();
    });

    it("Given a cached PR, When an update keeps the same PR (other tab or review link), Then the snapshot stays", async () => {
      // Given
      await withSnapshot();
      // When
      await service.callTool(AGENT, "ask_update", { id: "A1", links: [{ label: "PR", url: `${PR_A}/files` }, { label: "Review", url: `${PR_A}#pullrequestreview-9` }] });
      // Then
      expect(new AskStore(dir).get(WS, "A1")?.pr).toEqual(snapshot);
    });
  });

  describe("relaying asks to the agent whose chat points at them", () => {
    const OTHER_WS = "wks_2";
    const T0 = "2026-11-17T10:00:00.000Z";
    const T1 = "2026-11-17T10:05:00.000Z";
    let owner: AsksService;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(T0) });
      owner = new AsksService(store, outbox, async () => OTHER_WS);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("Given an ask in wks_2 owned by someone else, When relay is called for agent-1, Then the ask records one relay to agent-1 and its updatedAt is unchanged", async () => {
      // Given
      await owner.callTool("agent-2", "ask_create", decision);
      vi.setSystemTime(new Date(T1));
      // When
      const result = await service.relay({ readerAgentId: AGENT, asks: [{ workspaceId: OTHER_WS, id: "A1" }] });
      // Then
      const stored = new AskStore(dir).get(OTHER_WS, "A1");
      expect(result).toEqual({ relayed: [{ workspaceId: OTHER_WS, id: "A1" }] });
      expect(stored?.relayedTo).toEqual([{ agentId: AGENT, at: T1 }]);
      expect(stored?.updatedAt).toBe(T0);
    });

    it("Given an ask already relayed to agent-1 and to another reader, When it is relayed to agent-1 again, Then agent-1 still has one entry, with the newer time, and the other reader keeps its own", async () => {
      // Given
      await owner.callTool("agent-2", "ask_create", decision);
      await service.relay({ readerAgentId: AGENT, asks: [{ workspaceId: OTHER_WS, id: "A1" }] });
      await service.relay({ readerAgentId: "cos-2", asks: [{ workspaceId: OTHER_WS, id: "A1" }] });
      vi.setSystemTime(new Date(T1));
      // When
      await service.relay({ readerAgentId: AGENT, asks: [{ workspaceId: OTHER_WS, id: "A1" }] });
      // Then
      const relayedTo = new AskStore(dir).get(OTHER_WS, "A1")?.relayedTo ?? [];
      expect(relayedTo.filter((entry) => entry.agentId === AGENT)).toEqual([{ agentId: AGENT, at: T1 }]);
      expect(relayedTo.filter((entry) => entry.agentId === "cos-2")).toEqual([{ agentId: "cos-2", at: T0 }]);
    });

    it("Given one existing and one missing ask, When relay is called, Then it fails naming the missing wks_2/A9 and writes nothing", async () => {
      // Given
      await owner.callTool("agent-2", "ask_create", decision);
      // When
      const relay = service.relay({ readerAgentId: AGENT, asks: [{ workspaceId: OTHER_WS, id: "A1" }, { workspaceId: OTHER_WS, id: "A9" }] });
      // Then
      await expect(relay).rejects.toThrow("wks_2/A9");
      expect(new AskStore(dir).get(OTHER_WS, "A1")?.relayedTo).toBeUndefined();
    });

    it("Given a payload that names one ask twice, When relay is called, Then the ask is relayed once and ranked by its first pointer", async () => {
      // Given
      for (const title of ["First pointer", "Second pointer"]) await owner.callTool("agent-2", "ask_create", { kind: "question", title });
      vi.setSystemTime(new Date(T1));
      // When
      const result = await service.relay({
        readerAgentId: AGENT,
        asks: [{ workspaceId: OTHER_WS, id: "A1" }, { workspaceId: OTHER_WS, id: "A2" }, { workspaceId: OTHER_WS, id: "A1" }],
      });
      // Then
      expect(result).toEqual({ relayed: [{ workspaceId: OTHER_WS, id: "A1" }, { workspaceId: OTHER_WS, id: "A2" }] });
      expect(store.get(OTHER_WS, "A1")?.relayedTo).toEqual([{ agentId: AGENT, at: T1 }]);
      expect(firstExpanded(store.list(), AGENT)).toEqual(["wks_2/A1", "wks_2/A2"]);
    });

    it("Given two asks relayed in one request and an older relay from an earlier request, When the reader's expanded rows are picked, Then they are the two new asks, first-pointed first, and not the old one", async () => {
      // Given
      for (const title of ["Old pointer", "Second pointer", "First pointer"]) await owner.callTool("agent-2", "ask_create", { kind: "question", title });
      await service.relay({ readerAgentId: AGENT, asks: [{ workspaceId: OTHER_WS, id: "A1" }] });
      vi.setSystemTime(new Date(T1));
      await service.relay({ readerAgentId: AGENT, asks: [{ workspaceId: OTHER_WS, id: "A3" }, { workspaceId: OTHER_WS, id: "A2" }] });
      // When
      const expanded = firstExpanded(store.list(), AGENT);
      // Then
      expect(expanded).toEqual(["wks_2/A3", "wks_2/A2"]);
    });

    it("Given the only ask relayed to agent-1 is done, When the reader's expanded rows are picked, Then there are none", async () => {
      // Given
      await owner.callTool("agent-2", "ask_create", { kind: "question", title: "Which region?" });
      await service.relay({ readerAgentId: AGENT, asks: [{ workspaceId: OTHER_WS, id: "A1" }] });
      await owner.callTool("agent-2", "ask_resolve", { id: "A1" });
      // When
      const expanded = firstExpanded(store.list(), AGENT);
      // Then
      expect(expanded).toEqual([]);
    });
  });
});

describe("composer pill label", () => {
  const ask = (ownerAgentId: string, status: Ask["status"]) => ({ ownerAgentId, status });

  it("counts every ask the popover lists for that agent, so an in-progress ask never shows as No asks", () => {
    expect(pillLabel([], AGENT)).toBe("No asks");
    expect(pillLabel([ask(AGENT, "in_progress")], AGENT)).toBe("Asks · 1 in progress");
    expect(pillLabel([ask(AGENT, "open"), ask(AGENT, "open"), ask(AGENT, "in_progress")], AGENT)).toBe("Asks · 2 · 1 in progress");
    expect(pillLabel([ask("someone-else", "open"), ask(AGENT, "done"), ask(AGENT, "dropped")], AGENT)).toBe("No asks");
  });

  it("Given owned and relayed open asks plus a relayed done ask, When the label is built, Then it counts owned and relayed open or in-progress asks and ignores the done one", () => {
    // Given
    const relayed = (status: Ask["status"], agentId = AGENT) => ({ ownerAgentId: "someone-else", status, relayedTo: [{ agentId, at: "2026-11-17T10:00:00.000Z" }] });
    const asks = [ask(AGENT, "open"), relayed("open"), relayed("in_progress"), relayed("done"), relayed("open", "cos-2")];
    // When
    const label = pillLabel(asks, AGENT);
    // Then
    expect(label).toBe("Asks · 2 · 1 in progress");
  });
});
