import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Outbox, type AgentState, type Courier } from "../server/outbox";
import { AskAlreadyClosedError, AskOwnerLiveError, AsksService, AskTargetNotLiveError, type ActLogEntry, type AdminLogEntry, type OwnerState as AdminOwnerState } from "../server/service";
import { AskStore } from "../server/store";
import { RunStatus, type OwnerState } from "../server/run-status";
import { firstExpanded, latestRelays, OPEN_STATUSES, pillLabel, visibleActions, type Ask } from "../shared/asks";

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

  describe("ask_list scopes", () => {
    const OTHER_WS = "wks_2";
    const OTHER_AGENT = "agent-2";

    beforeEach(async () => {
      const input = { kind: "question" as const, title: "Unrelated", actions: [], links: [] };
      await service.callTool(AGENT, "ask_create", { kind: "question", title: "Own ask" });
      for (let index = 2; index <= 9; index++) {
        await store.create({ ...input, workspaceId: WS, ownerAgentId: OTHER_AGENT, status: index === 9 ? "open" : "done" });
      }
      for (let index = 1; index <= 7; index++) {
        await store.create({ ...input, workspaceId: OTHER_WS, ownerAgentId: OTHER_AGENT, title: "Relayed ask", status: index === 7 ? "open" : "done" });
      }
      await service.relay({ readerAgentId: AGENT, asks: [{ workspaceId: OTHER_WS, id: "A7" }] });
    });

    it("Given own A1 in W1, relayed A7 in W2 and unrelated A9 in W1, When listing scope pill, Then only A1 and A7 appear with A7's owner and workspace", async () => {
      // Given: the caller owns A1 and reads A7 from another workspace.
      // When
      const result = await service.callTool(AGENT, "ask_list", { scope: "pill" });
      // Then
      expect(result.isError).toBeUndefined();
      expect(result.text.split("\n")).toEqual([
        "A1 [in_progress] question: Own ask",
        "A7 [open] question: Relayed ask (not yours; owner: agent-2; workspace: wks_2)",
      ]);
    });

    it.each([undefined, "workspace", "mine"] as const)("Given own and other agents' asks across workspaces, When listing scope %s, Then existing workspace and ownership filters are unchanged", async (scope) => {
      // Given: A9 belongs to another agent in this workspace; A7 is relayed from another.
      // When
      const result = await service.callTool(AGENT, "ask_list", scope ? { scope } : {});
      // Then
      expect(result.isError).toBeUndefined();
      expect(result.text.split("\n")).toEqual(scope === "mine"
        ? ["A1 [in_progress] question: Own ask"]
        : ["A1 [in_progress] question: Own ask", "A9 [open] question: Unrelated"]);
    });

    it("Given closed own and relayed asks, When listing scope pill, Then the status filter excludes them unless all is requested", async () => {
      // Given
      await store.update(WS, "A1", { status: "done" });
      await store.update(OTHER_WS, "A7", { status: "dropped" });
      // When
      const open = await service.callTool(AGENT, "ask_list", { scope: "pill" });
      const all = await service.callTool(AGENT, "ask_list", { scope: "pill", status: "all" });
      // Then
      expect(open).toEqual({ text: "No asks." });
      expect(all).toEqual({ text: [
        "A1 [done] question: Own ask",
        "A7 [dropped] question: Relayed ask (not yours; owner: agent-2; workspace: wks_2)",
      ].join("\n") });
    });
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

  it("Given an automatically in-progress ask, When its send action is used, Then unsent actions were visible and sent actions are hidden", async () => {
    // Given
    await service.callTool(AGENT, "ask_create", {
      kind: "followup", title: "Approve follow-up",
      actions: [{ label: "Approve", kind: "send" }, { label: "Inspect", kind: "open", url: "https://example.com" }],
    });
    const before = visibleActions(store.get(WS, "A1")!).map((action) => action.label);
    // When
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" });
    // Then
    expect(before).toEqual(["Approve", "Inspect"]);
    expect(visibleActions(store.get(WS, "A1")!).map((action) => action.label)).toEqual(["Inspect"]);
  });

  it("Given reconciliation awaits owner state, When a human sends before it resumes, Then the send stays hidden and cannot deliver twice", async () => {
    // Given
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Approve", actions: [{ label: "Approve", kind: "send" }] });
    let resume!: (state: OwnerState) => void;
    const state = new Promise<OwnerState>((resolve) => { resume = resolve; });
    const reconcile = new RunStatus(store, () => {}).reconcile(() => state);
    // When
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" });
    resume("idle");
    await reconcile;
    // Then
    expect(store.get(WS, "A1")).toMatchObject({ status: "in_progress", autoStatus: false });
    expect(visibleActions(store.get(WS, "A1")!)).toEqual([]);
    await expect(service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" })).rejects.toThrow(/already sent/);
    expect(courier.sent).toHaveLength(1);
  });

  it("Given an ask with a send action, When two sends start concurrently, Then one is applied, the other is refused, and one delivery is queued", async () => {
    // Given
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Approve", actions: [{ label: "Approve", kind: "send" }] });
    courier.states.set(AGENT, "running");
    // When
    const results = await Promise.allSettled([
      service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" }),
      service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" }),
    ]);
    // Then
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(refused.map((result) => (result.reason as Error).message)).toEqual(["A1 send action was already sent; nothing was changed or sent"]);
    expect(outbox.pending(AGENT)).toHaveLength(1);
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
      expect(stored?.relayedTo).toMatchObject([{ agentId: AGENT, at: T1 }]);
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
      expect(relayedTo.filter((entry) => entry.agentId === AGENT)).toMatchObject([{ agentId: AGENT, at: T1 }]);
      expect(relayedTo.filter((entry) => entry.agentId === "cos-2")).toMatchObject([{ agentId: "cos-2", at: T0 }]);
    });

    it("Given targets become ineligible before the lock runs, When relayed across workspaces, Then all stamps are refused", async () => {
      // Given
      await service.callTool(AGENT, "ask_create", decision);
      for (let i = 0; i < 3; i++) await owner.callTool("agent-2", "ask_create", decision);
      const changes = [
        store.update(OTHER_WS, "A1", { status: "done" }),
        store.update(OTHER_WS, "A2", { orphaned: true }),
        store.update(OTHER_WS, "A3", { status: "dropped" }),
      ];
      // When
      const relay = service.relay({ readerAgentId: AGENT, asks: [
        { workspaceId: WS, id: "A1" },
        ...["A1", "A2", "A3"].map((id) => ({ workspaceId: OTHER_WS, id })),
      ] });
      // Then
      await expect(relay).rejects.toThrow(/wks_2\/A1.*wks_2\/A2.*wks_2\/A3/);
      await Promise.all(changes);
      expect(new AskStore(dir).list().every((ask) => ask.relayedTo === undefined)).toBe(true);
    });

    it("Given two readers relay the same ask concurrently, When both complete, Then both persisted reader stamps remain", async () => {
      // Given
      await owner.callTool("agent-2", "ask_create", decision);
      const asks = [{ workspaceId: OTHER_WS, id: "A1" }];
      // When
      await Promise.all(["reader-one", "reader-two"].map((readerAgentId) => service.relay({ readerAgentId, asks })));
      // Then
      expect(new AskStore(dir).get(OTHER_WS, "A1")?.relayedTo?.map((entry) => entry.agentId).sort()).toEqual(["reader-one", "reader-two"]);
    });

    it("Given two relay requests four seconds apart, When selecting expanded rows, Then only the second batch expands in pointer order", async () => {
      // Given
      for (let i = 0; i < 3; i++) await owner.callTool("agent-2", "ask_create", decision);
      await service.relay({ readerAgentId: AGENT, asks: [{ workspaceId: OTHER_WS, id: "A1" }] });
      vi.setSystemTime(new Date(Date.parse(T0) + 4000));
      // When
      await service.relay({ readerAgentId: AGENT, asks: ["A3", "A2"].map((id) => ({ workspaceId: OTHER_WS, id })) });
      // Then
      expect(firstExpanded(new AskStore(dir).list(), AGENT)).toEqual(["wks_2/A3", "wks_2/A2"]);
    });

    it("Given legacy relay entries without batch identities, When expanded rows are selected, Then only the newest legacy ask expands", async () => {
      // Given
      for (let i = 0; i < 2; i++) await owner.callTool("agent-2", "ask_create", decision);
      await store.update(OTHER_WS, "A1", { relayedTo: [{ agentId: AGENT, at: T0 }] });
      await store.update(OTHER_WS, "A2", { relayedTo: [{ agentId: AGENT, at: new Date(Date.parse(T0) + 1000).toISOString() }] });
      // When
      const expanded = firstExpanded(new AskStore(dir).list(), AGENT);
      // Then
      expect(expanded).toEqual(["wks_2/A2"]);
    });

    it("Given two requests in the same millisecond, When selecting expanded rows, Then the later request alone expands", async () => {
      // Given
      for (let i = 0; i < 2; i++) await owner.callTool("agent-2", "ask_create", decision);
      await service.relay({ readerAgentId: AGENT, asks: [{ workspaceId: OTHER_WS, id: "A1" }] });
      // When
      await service.relay({ readerAgentId: AGENT, asks: [{ workspaceId: OTHER_WS, id: "A2" }] });
      // Then
      expect(firstExpanded(new AskStore(dir).list(), AGENT)).toEqual(["wks_2/A2"]);
    });

    it("Given two batches in the same millisecond, When the first new pointer resolves, Then the remaining new pointer expands instead of the older batch", async () => {
      // Given
      for (let i = 0; i < 3; i++) await owner.callTool("agent-2", "ask_create", decision);
      await service.relay({ readerAgentId: AGENT, asks: [{ workspaceId: OTHER_WS, id: "A1" }] });
      await service.relay({ readerAgentId: AGENT, asks: ["A2", "A3"].map((id) => ({ workspaceId: OTHER_WS, id })) });
      // When
      await owner.callTool("agent-2", "ask_resolve", { id: "A2" });
      // Then
      expect(firstExpanded(new AskStore(dir).list(), AGENT)).toEqual(["wks_2/A3"]);
    });

    it("Given the newest batch is fully resolved and an older relay remains open, When selecting from the open list with latest relay metadata, Then nothing expands", async () => {
      // Given
      for (let i = 0; i < 3; i++) await owner.callTool("agent-2", "ask_create", decision);
      await service.relay({ readerAgentId: AGENT, asks: [{ workspaceId: OTHER_WS, id: "A1" }] });
      await service.relay({ readerAgentId: AGENT, asks: ["A2", "A3"].map((id) => ({ workspaceId: OTHER_WS, id })) });
      await owner.callTool("agent-2", "ask_resolve", { id: "A2" });
      await owner.callTool("agent-2", "ask_resolve", { id: "A3" });
      // When
      const all = new AskStore(dir).list();
      const open = all.filter((ask) => OPEN_STATUSES.includes(ask.status));
      const expanded = firstExpanded(open, AGENT, latestRelays(all)[AGENT]);
      // Then
      expect(open.map((ask) => ask.id)).toEqual(["A1"]);
      expect(expanded).toEqual([]);
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
      expect(store.get(OTHER_WS, "A1")?.relayedTo).toMatchObject([{ agentId: AGENT, at: T1 }]);
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

  describe("moving or closing an ask whose owner is closed", () => {
    const OTHER_WS = "wks_2";
    const TARGET = "agent-2";
    const NEIGHBOR = "agent-3";
    const workspaces: Record<string, string> = { [AGENT]: WS, [TARGET]: OTHER_WS, [NEIGHBOR]: WS };
    let states: Map<string, AdminOwnerState>;
    let log: Mock<(entry: ActLogEntry | AdminLogEntry) => void>;
    let admin: AsksService;

    beforeEach(async () => {
      states = new Map();
      log = vi.fn();
      admin = new AsksService(store, outbox, async (agentId) => workspaces[agentId] ?? null, log, () => {}, async (agentId) => states.get(agentId) ?? "idle");
      await admin.callTool(AGENT, "ask_create", decision);
    });

    it("Given an ask whose owner is closed, When reassigned to a live agent in another workspace, Then the target has a new open copy, the old ask is dropped with a note, and the target gets one message", async () => {
      // Given
      states.set(AGENT, "closed");
      const original = store.get(WS, "A1")!;
      // When
      const { moved, from } = await admin.reassign({ workspaceId: WS, id: "A1", toAgentId: TARGET, reason: "owner session ended", by: "cos-1" });
      await outbox.flush();
      // Then
      const copy = new AskStore(dir).get(OTHER_WS, "A1");
      expect(moved).toEqual(copy);
      expect(copy).toMatchObject({ ownerAgentId: TARGET, status: "open", title: original.title, actions: original.actions });
      expect(copy?.outcome).toBeUndefined();
      expect(copy?.autoStatus).toBeUndefined();
      const old = new AskStore(dir).get(WS, "A1");
      expect(from).toEqual(old);
      expect(old?.status).toBe("dropped");
      expect(old?.outcome).toMatchObject({ by: "agent", note: `Moved to ${OTHER_WS}/A1 (owner ${AGENT} closed) by cos-1: owner session ended` });
      expect(courier.sent).toEqual([{ agentId: TARGET, text: expect.stringMatching(/^\[asks\] A1 \(Squash-only merges\?\) is now yours\. It moved from wks_1\/A1/), messageId: expect.any(String) }]);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ verb: "reassign", ownerAgentId: AGENT, ownerState: "closed", movedTo: `${OTHER_WS}/A1`, before: "in_progress", after: "dropped" }));
      expect(log.mock.calls[0]![0].error).toBeUndefined();
    });

    it("Given an ask whose owner is closed, When reassigned to a live agent in the same workspace, Then the same id has the new owner and is open", async () => {
      // Given
      states.set(AGENT, "gone");
      // When
      const { moved } = await admin.reassign({ workspaceId: WS, id: "A1", toAgentId: NEIGHBOR, reason: "taking over", by: "cos-1" });
      // Then
      expect(moved.id).toBe("A1");
      expect(store.list(WS)).toHaveLength(1);
      expect(store.get(WS, "A1")).toMatchObject({ ownerAgentId: NEIGHBOR, status: "open" });
      expect(store.get(WS, "A1")?.autoStatus).toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ verb: "reassign", movedTo: `${WS}/A1`, after: "open" }));
    });

    it("Given the owner is idle, When the ask is reassigned or closed, Then each throws AskOwnerLiveError and nothing in the store changed", async () => {
      // Given
      const snapshot = structuredClone(store.list());
      // When
      const reassigning = admin.reassign({ workspaceId: WS, id: "A1", toAgentId: TARGET, reason: "r", by: "cos-1" });
      await expect(reassigning).rejects.toBeInstanceOf(AskOwnerLiveError);
      const closing = admin.close({ workspaceId: WS, id: "A1", reason: "r", by: "cos-1" });
      await expect(closing).rejects.toThrow(/^AskOwnerLiveError: wks_1\/A1 owner agent-1 is idle/);
      // Then
      expect(store.list()).toEqual(snapshot);
      expect(courier.sent).toEqual([]);
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls.map(([entry]) => entry as AdminLogEntry).map((entry) => [entry.verb, entry.ownerState, entry.error?.split(":")[0]])).toEqual([
        ["reassign", "idle", "AskOwnerLiveError"],
        ["close", "idle", "AskOwnerLiveError"],
      ]);
    });

    it("Given the owner and the target are closed, When the ask is reassigned, Then it throws AskTargetNotLiveError and nothing changed", async () => {
      // Given
      states.set(AGENT, "closed");
      states.set(TARGET, "closed");
      const snapshot = structuredClone(store.list());
      // When
      const reassigning = admin.reassign({ workspaceId: WS, id: "A1", toAgentId: TARGET, reason: "r", by: "cos-1" });
      // Then
      await expect(reassigning).rejects.toBeInstanceOf(AskTargetNotLiveError);
      expect(store.list()).toEqual(snapshot);
      expect(store.list(OTHER_WS)).toEqual([]);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ verb: "reassign", toAgentId: TARGET, error: expect.stringMatching(/^AskTargetNotLiveError: /) }));
    });

    it("Given an ask whose owner is closed, When it is closed with a reason, Then it is done with the reason as an agent outcome and nobody is messaged", async () => {
      // Given
      states.set(AGENT, "closed");
      // When
      const { ask } = await admin.close({ workspaceId: WS, id: "A1", reason: "superseded by A7", by: "cos-1" });
      await outbox.flush();
      // Then
      expect(new AskStore(dir).get(WS, "A1")).toEqual(ask);
      expect(ask.status).toBe("done");
      expect(ask.outcome).toMatchObject({ by: "agent", note: "superseded by A7" });
      expect(courier.sent).toEqual([]);
      expect(outbox.pending()).toEqual([]);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ verb: "close", by: "cos-1", reason: "superseded by A7", ownerState: "closed", before: "in_progress", after: "done" }));
    });

    it("Given an already-done ask, When it is closed, Then it throws AskAlreadyClosedError and logs the refusal", async () => {
      // Given
      states.set(AGENT, "closed");
      await store.update(WS, "A1", { status: "done" });
      // When
      const closing = admin.close({ workspaceId: WS, id: "A1", reason: "r", by: "cos-1" });
      // Then
      await expect(closing).rejects.toBeInstanceOf(AskAlreadyClosedError);
      expect(store.get(WS, "A1")?.outcome).toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ verb: "close", before: "done", error: expect.stringMatching(/^AskAlreadyClosedError: /) }));
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
