import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Outbox, type Courier } from "../server/outbox";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";
import { STALE_MS } from "../server/stuck";
import { RunStatus } from "../server/run-status";
import type { PrState } from "../shared/asks";

const WS = "wks_1";
const AGENT = "agent-1";
const PR_URL = "https://github.com/acme/app/pull/30";

const pr = (patch: Partial<PrState> = {}): PrState => ({
  number: 30,
  url: PR_URL,
  state: "OPEN",
  isDraft: false,
  reviewDecision: null,
  checks: "passing",
  mergeable: "MERGEABLE",
  fetchedAt: new Date().toISOString(),
  ...patch,
});

describe("asks stuck in progress", () => {
  let store: AskStore;
  let outbox: Outbox;
  let service: AsksService;
  let sent: string[];

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "asks-stuck-"));
    store = new AskStore(dir);
    sent = [];
    const courier: Courier = {
      state: async () => "idle",
      send: async (_agentId, text) => void sent.push(text),
    };
    outbox = new Outbox(dir, courier, async () => {});
    service = new AsksService(store, outbox, async (agentId) => (agentId === AGENT ? WS : null));
  });

  afterEach(() => vi.useRealTimers());

  const prAsk = async () => {
    await service.callTool(AGENT, "ask_create", {
      kind: "pr",
      title: "Merge PR #30",
      subscribe: true,
      links: [{ label: "PR #30", url: PR_URL }],
      actions: [{ label: "Merge when green", kind: "send", prompt: "Merge PR #30 once checks pass" }],
    });
    // The human clicks: the ask becomes the agent's.
    const { ask } = await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" });
    return ask;
  };

  it("tells the agent to reopen the ask when the PR waits on the human, not to leave it in progress", async () => {
    await prAsk();
    await outbox.flush(AGENT);
    expect(sent[0]).toContain("If it waits on the human (a label, an approval, a merge only they can do), ask_update it");
    expect(sent[0]).not.toContain("If the PR still waits on the human after it");
  });

  it("Given fresh actions with explicit in_progress, When the owner's turn ends, Then the deliberate hold stays", async () => {
    // Given
    await prAsk();
    // When
    const result = await service.callTool(AGENT, "ask_update", {
      id: "A1",
      status: "in_progress",
      actions: [{ label: "Authorize: add QA labels + merge", kind: "send", prompt: "Add the labels and merge" }],
    });
    expect(result.text).toMatch(/^A1 \[in_progress\]/);
    expect(store.get(WS, "A1")?.autoStatus).toBe(false);
    await new RunStatus(store, () => {}).turnEnded(AGENT);
    // Then
    expect(store.get(WS, "A1")).toMatchObject({ status: "in_progress", autoStatus: false });
  });

  it("still lets the agent resolve or drop an ask while giving it actions", async () => {
    await prAsk();
    await service.callTool(AGENT, "ask_update", {
      id: "A1",
      status: "dropped",
      actions: [{ label: "x", kind: "send", prompt: "x" }],
    });
    expect(store.get(WS, "A1")?.status).toBe("dropped");
  });

  it("reminds the owner once when its turn ends holding an in-progress ask", async () => {
    await prAsk();
    await outbox.flush(AGENT);
    sent.length = 0;
    await service.remindStuck(AGENT, WS);
    await outbox.flush(AGENT);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Your turn ended with A1 (Merge PR #30) in progress");
    // A quiet rerun: nothing changed since the reminder.
    await service.remindStuck(AGENT, WS);
    await outbox.flush(AGENT);
    expect(sent).toHaveLength(1);
    // The ask changes (another click), so it may be reminded again.
    await service.callTool(AGENT, "ask_update", { id: "A1", body: "rebased" });
    await service.remindStuck(AGENT, WS);
    await outbox.flush(AGENT);
    expect(sent).toHaveLength(2);
  });

  it("does not remind while a subscribed PR's checks are pending: the watcher wakes the owner", async () => {
    await prAsk();
    await store.update(WS, "A1", { pr: pr({ checks: "pending" }) }, { touch: false });
    await outbox.flush(AGENT);
    sent.length = 0;
    await service.remindStuck(AGENT, WS);
    await outbox.flush(AGENT);
    expect(sent).toHaveLength(0);
  });

  it("hands an archived owner's in-progress asks back to the human", async () => {
    await prAsk();
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Untouched" });
    await new RunStatus(store, () => {}).turnEnded(AGENT);
    const released = await service.releaseOwner(AGENT);
    expect(released.map((ask) => ask.id)).toEqual(["A1"]);
    expect(store.get(WS, "A1")?.status).toBe("open");
  });

  it("reopens a stale automatically held ask whose owner is not running, and leaves the rest", async () => {
    await service.callTool(AGENT, "ask_create", { kind: "question", title: "Which region?" });
    const later = new Date(Date.parse(store.get(WS, "A1")!.updatedAt) + STALE_MS);
    const early = new Date(later.getTime() - 1000);
    expect(await service.reopenStale(async () => false, early)).toEqual([]);
    expect(await service.reopenStale(async () => true, later)).toEqual([]);
    const reopened = await service.reopenStale(async () => false, later);
    expect(reopened.map((ask) => ask.id)).toEqual(["A1"]);
    expect(store.get(WS, "A1")?.status).toBe("open");
  });

  it.each(["explicit", "human-send"] as const)("Given a %s hold, When the idle ask is older than a day, Then it stays held", async (hold) => {
    // Given
    if (hold === "human-send") await prAsk();
    else {
      await service.callTool(AGENT, "ask_create", { kind: "question", title: "Which region?" });
      await service.callTool(AGENT, "ask_update", { id: "A1", status: "in_progress" });
    }
    const before = store.get(WS, "A1")!;
    const later = new Date(Date.parse(before.updatedAt) + STALE_MS * 2);
    // When
    const reopened = await service.reopenStale(async () => false, later);
    // Then
    expect(reopened).toEqual([]);
    expect(store.get(WS, "A1")).toEqual(before);
    expect(store.get(WS, "A1")).toMatchObject({ status: "in_progress", autoStatus: false });
  });

  it.each(["dropped", "done", "owner", "updated"] as const)("Given a stale ask, When it is %s during owner lookup, Then reopening preserves the newer state", async (change) => {
    // Given
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T00:00:00.000Z") });
    await service.callTool(AGENT, "ask_create", { kind: "question", title: "Which region?" });
    const observed = store.get(WS, "A1")!;
    const later = new Date(Date.parse(observed.updatedAt) + STALE_MS);
    let changed = observed;
    // When
    const reopened = await service.reopenStale(async () => {
      vi.setSystemTime(later);
      changed = await store.update(WS, "A1",
        change === "owner" ? { ownerAgentId: "new-owner" } :
        change === "updated" ? { body: "Work resumed" } : { status: change },
        { touch: change !== "owner" });
      return false;
    }, later);
    // Then
    expect(reopened).toEqual([]);
    expect(store.get(WS, "A1")).toEqual(changed);
    expect(store.get(WS, "A1")?.status).toBe(change === "done" || change === "dropped" ? change : "in_progress");
  });

  it("Given stale asks share an owner, When lookup fails, Then neither reopens and the failure is cached for the scan", async () => {
    // Given
    await service.callTool(AGENT, "ask_create", { kind: "question", title: "Which zone?" });
    await service.callTool(AGENT, "ask_create", { kind: "question", title: "Which region?" });
    const later = new Date(Date.now() + STALE_MS);
    const lookup = vi.fn(async () => { throw new Error("Unavailable"); });
    // When
    const reopened = await service.reopenStale(lookup, later);
    // Then
    expect(reopened).toEqual([]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(store.list(WS).every((ask) => ask.status === "in_progress")).toBe(true);
  });
});
