import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AskSchema, canAnswer, visibleActions, type Action, type Ask } from "../shared/asks";
import { Outbox, type AgentState, type Courier } from "../server/outbox";
import { RunStatus, type FlipLogEntry, type OwnerState } from "../server/run-status";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";

const WS = "wks_1";
const OWNER = "agent-1";
const OTHER = "agent-2";

const idleCourier: Courier = {
  async state() {
    return "idle";
  },
  async send() {},
};

describe("status follows the owner", () => {
  let dir: string;
  let store: AskStore;
  let service: AsksService;
  let runStatus: RunStatus;
  let flips: FlipLogEntry[];
  let ownerState: OwnerState;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "asks-run-status-"));
    store = new AskStore(dir);
    flips = [];
    ownerState = "running";
    const log = (entry: FlipLogEntry) => void flips.push(entry);
    runStatus = new RunStatus(store, log);
    service = new AsksService(store, new Outbox(dir, idleCourier), async () => WS, undefined, undefined, undefined, async () => ownerState, log);
  });

  const raise = (ownerAgentId: string, title = "Review") =>
    store.create({ workspaceId: WS, ownerAgentId, kind: "followup", title, links: [], actions: [] });
  const statusOf = (id: string) => store.get(WS, id)!;

  it("turn start flips the owner's open ask and leaves other owners alone", async () => {
    const mine = await raise(OWNER);
    const theirs = await raise(OTHER);
    await runStatus.turnStarted(OWNER);
    expect(statusOf(mine.id)).toMatchObject({ status: "in_progress", autoStatus: true });
    expect(statusOf(theirs.id).status).toBe("open");
    expect(flips).toMatchObject([{ cause: "turn_started", askId: mine.id, ownerAgentId: OWNER, workspaceId: WS, from: "open", to: "in_progress" }]);
  });

  it("turn end reverts only automatic in_progress; a human send stays", async () => {
    const auto = await raise(OWNER, "auto");
    const sent = await store.create({ workspaceId: WS, ownerAgentId: OWNER, kind: "pr", title: "sent", links: [], actions: [{ label: "Merge", kind: "send", prompt: "Merge it" }] });
    await runStatus.turnStarted(OWNER);
    await service.act({ workspaceId: WS, id: sent.id, verb: "action", actionId: "a1" });
    expect(statusOf(sent.id)).toMatchObject({ status: "in_progress", autoStatus: false });
    flips.length = 0;

    await runStatus.turnEnded(OWNER);
    expect(statusOf(auto.id)).toMatchObject({ status: "open", autoStatus: false });
    expect(statusOf(sent.id)).toMatchObject({ status: "in_progress", autoStatus: false });
    expect(flips).toMatchObject([{ cause: "turn_ended", askId: auto.id, from: "in_progress", to: "open" }]);
  });

  it("never touches done, dropped, or explicitly in-progress asks", async () => {
    const done = await raise(OWNER, "done");
    const dropped = await raise(OWNER, "dropped");
    const explicit = await raise(OWNER, "explicit");
    await store.update(WS, done.id, { status: "done" });
    await store.update(WS, dropped.id, { status: "dropped", autoStatus: true });
    await store.update(WS, explicit.id, { status: "in_progress", autoStatus: false });
    await runStatus.turnStarted(OWNER);
    await runStatus.turnEnded(OWNER);
    await runStatus.reconcile(async () => "running");
    expect(statusOf(done.id).status).toBe("done");
    expect(statusOf(dropped.id).status).toBe("dropped");
    expect(statusOf(explicit.id)).toMatchObject({ status: "in_progress", autoStatus: false });
    expect(flips).toEqual([]);
  });

  it("ask_create by a running owner stores in_progress auto, and turn end opens it", async () => {
    const result = await service.callTool(OWNER, "ask_create", { kind: "followup", title: "Look at this" });
    expect(result.isError).not.toBe(true);
    expect(result.text).toMatch(/^A1 \[in_progress\]/);
    expect(statusOf("A1")).toMatchObject({ status: "in_progress", autoStatus: true });
    expect(flips).toMatchObject([{ cause: "owner_call", askId: "A1", from: "open", to: "in_progress" }]);

    await runStatus.turnEnded(OWNER);
    expect(statusOf("A1")).toMatchObject({ status: "open", autoStatus: false });
    expect(flips.at(-1)).toMatchObject({ cause: "turn_ended", from: "in_progress", to: "open" });
  });

  it("owner creation assumes a running tool call even before the host reports running", async () => {
    ownerState = "idle";
    const result = await service.callTool(OWNER, "ask_create", { kind: "followup", title: "Raised during a turn" });
    expect(result.isError).not.toBe(true);
    expect(statusOf("A1")).toMatchObject({ status: "in_progress", autoStatus: true });
    expect(flips).toMatchObject([{ cause: "owner_call", askId: "A1", from: "open", to: "in_progress" }]);
  });

  it("an owner's ask_update to open mid-turn stores in_progress auto; explicit in_progress is sticky", async () => {
    await service.callTool(OWNER, "ask_create", { kind: "followup", title: "Look at this" });
    await runStatus.turnEnded(OWNER);
    flips.length = 0;

    const opened = await service.callTool(OWNER, "ask_update", { id: "A1", status: "open" });
    expect(opened.isError).not.toBe(true);
    expect(statusOf("A1")).toMatchObject({ status: "in_progress", autoStatus: true });
    expect(flips).toMatchObject([{ cause: "owner_call", from: "open", to: "in_progress" }]);

    const held = await service.callTool(OWNER, "ask_update", { id: "A1", status: "in_progress" });
    expect(held.isError).not.toBe(true);
    expect(statusOf("A1")).toMatchObject({ status: "in_progress", autoStatus: false });
    await runStatus.turnEnded(OWNER);
    expect(statusOf("A1")).toMatchObject({ status: "in_progress", autoStatus: false });
  });

  it("a non-owner's ask_update remains explicit and does not log an automatic flip", async () => {
    const ask = await raise(OWNER);
    const result = await service.callTool(OTHER, "ask_update", { id: ask.id, status: "in_progress" });
    expect(result.isError).not.toBe(true);
    expect(statusOf(ask.id).status).toBe("in_progress");
    expect(statusOf(ask.id).autoStatus).not.toBe(true);
    expect(flips).toEqual([]);
  });

  it("reconcile repairs missed events with one lookup per owner", async () => {
    const stale = await raise(OWNER, "stale");
    const missed = await raise(OTHER, "missed");
    const alsoMissed = await raise(OTHER, "also missed");
    await runStatus.turnStarted(OWNER);
    flips.length = 0;
    const lookups: string[] = [];
    const state = async (agentId: string): Promise<OwnerState> => {
      lookups.push(agentId);
      return agentId === OTHER ? "running" : "idle";
    };

    await runStatus.reconcile(state);
    expect(statusOf(stale.id)).toMatchObject({ status: "open", autoStatus: false });
    expect(statusOf(missed.id)).toMatchObject({ status: "in_progress", autoStatus: true });
    expect(statusOf(alsoMissed.id)).toMatchObject({ status: "in_progress", autoStatus: true });
    expect([...lookups].sort()).toEqual([OWNER, OTHER]);
    expect(flips).toMatchObject([
      { cause: "reconcile", askId: stale.id, from: "in_progress", to: "open" },
      { cause: "reconcile", askId: missed.id, from: "open", to: "in_progress" },
      { cause: "reconcile", askId: alsoMissed.id, from: "open", to: "in_progress" },
    ]);
  });

  it("reload preserves automatic markers for reconciliation", async () => {
    const ask = await raise(OWNER);
    await runStatus.turnStarted(OWNER);
    const reloaded = new AskStore(dir);
    expect(reloaded.get(WS, ask.id)).toMatchObject({ status: "in_progress", autoStatus: true });
    flips.length = 0;

    await new RunStatus(reloaded, (entry) => void flips.push(entry)).reconcile(async () => "gone");
    expect(reloaded.get(WS, ask.id)).toMatchObject({ status: "open", autoStatus: false });
    expect(flips).toMatchObject([{ cause: "reconcile", askId: ask.id, from: "in_progress", to: "open" }]);
  });

  it("reconcile does not overwrite a human answer made while reading owner state", async () => {
    const ask = await store.create({ workspaceId: WS, ownerAgentId: OWNER, kind: "action", title: "Review", links: [], actions: [{ label: "Go", kind: "send" }] });
    await runStatus.turnStarted(OWNER);
    flips.length = 0;

    await runStatus.reconcile(async () => {
      await service.act({ workspaceId: WS, id: ask.id, verb: "action", actionId: "a1" });
      return "idle";
    });

    expect(statusOf(ask.id)).toMatchObject({ status: "in_progress", autoStatus: false, outcome: { label: "Go", by: "human" } });
    expect(flips).toEqual([]);
  });

  it("a no-op turn event does not write another flip log", async () => {
    await raise(OWNER);
    await runStatus.turnStarted(OWNER);
    await runStatus.turnStarted(OWNER);
    await runStatus.turnEnded(OWNER);
    await runStatus.turnEnded(OWNER);
    expect(flips.map(({ cause }) => cause)).toEqual(["turn_started", "turn_ended"]);
  });
});

describe("automatic status keeps the card answerable", () => {
  const actions: Action[] = [
    { id: "send", label: "Do it", kind: "send", prompt: "Do it" },
    { id: "resolve", label: "Accept", kind: "resolve" },
    { id: "open", label: "Open", kind: "open", url: "https://example.com" },
  ];

  it.each([
    ["open", undefined, ["send", "resolve", "open"]],
    ["in_progress", true, ["send", "resolve", "open"]],
    ["in_progress", false, ["resolve", "open"]],
    ["in_progress", undefined, ["resolve", "open"]],
    ["done", true, []],
    ["dropped", true, []],
  ] as const)("filters buttons for %s with autoStatus %s", (status, autoStatus, expected) => {
    expect(visibleActions({ status, autoStatus, actions }).map(({ id }) => id)).toEqual(expected);
  });

  it.each([
    ["open", true],
    ["in_progress", true],
    ["done", false],
    ["dropped", false],
  ] as const)("shows reply controls only when %s can accept an answer", (status, expected) => {
    expect(canAnswer({ status })).toBe(expected);
  });

  it("preserves automatic markers through the RPC ask schema and accepts older asks", () => {
    const ask: Ask = { id: "A1", workspaceId: WS, ownerAgentId: OWNER, kind: "followup", title: "Review", status: "in_progress", autoStatus: true, actions, links: [], createdAt: "2026-11-23T00:00:00Z", updatedAt: "2026-11-23T00:00:00Z" };
    expect(AskSchema.parse(ask).autoStatus).toBe(true);
    const { autoStatus: _autoStatus, ...legacy } = ask;
    expect(AskSchema.parse(legacy).autoStatus).toBeUndefined();
  });
});

describe("answers wait until idle", () => {
  it.each(["running", "steerable"] as const)("queues a human answer during a %s turn and sends it once after idle", async (initialState) => {
    const dir = mkdtempSync(join(tmpdir(), "asks-delivery-"));
    const store = new AskStore(dir);
    let state: AgentState = initialState;
    const sent: string[] = [];
    const outbox = new Outbox(dir, { state: async () => state, send: async (_agent, text) => void sent.push(text) });
    const service = new AsksService(store, outbox, async () => WS);
    const ask = await store.create({ workspaceId: WS, ownerAgentId: OWNER, kind: "action", title: "Do it", actions: [{ label: "Go", kind: "send" }], links: [] });
    const runStatus = new RunStatus(store, () => {});
    await runStatus.turnStarted(OWNER);

    const result = await service.act({ workspaceId: WS, id: ask.id, verb: "action", actionId: "a1" });
    await outbox.flush();
    expect(result.delivery).toBe("queued");
    expect(sent).toEqual([]);
    expect(outbox.pending(OWNER)).toHaveLength(1);
    expect(store.get(WS, ask.id)).toMatchObject({ status: "in_progress", autoStatus: false });

    state = "idle";
    await runStatus.turnEnded(OWNER);
    await outbox.flush();
    await outbox.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"Go"');
    expect(outbox.pending(OWNER)).toEqual([]);
    expect(store.get(WS, ask.id)).toMatchObject({ status: "in_progress", autoStatus: false });
  });

  it("keeps answers queued when the owner's state cannot be read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "asks-delivery-"));
    const sent: string[] = [];
    const outbox = new Outbox(dir, { state: async () => { throw new Error("disconnected"); }, send: async (_agent, text) => void sent.push(text) });
    outbox.enqueue({ agentId: OWNER, workspaceId: WS, text: "Answer" });
    await outbox.flush();
    expect(sent).toEqual([]);
    expect(outbox.pending(OWNER)).toHaveLength(1);
    expect(outbox.pending(OWNER)[0]!.attempts).toBe(0);
  });
});
