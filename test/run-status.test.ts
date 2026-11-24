import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Outbox, type Courier } from "../server/outbox";
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
  let store: AskStore;
  let service: AsksService;
  let runStatus: RunStatus;
  let flips: FlipLogEntry[];

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "asks-run-status-"));
    store = new AskStore(dir);
    flips = [];
    const log = (entry: FlipLogEntry) => flips.push(entry);
    runStatus = new RunStatus(store, log);
    service = new AsksService(store, new Outbox(dir, idleCourier, async () => {}), async () => WS, () => {}, log);
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
    expect(statusOf(sent.id).status).toBe("in_progress");
    expect(flips).toMatchObject([{ cause: "turn_ended", askId: auto.id, from: "in_progress", to: "open" }]);
  });

  it("Given turn end and the next turn start fire concurrently, when both settle, then the owner's ask is in_progress", async () => {
    // Given
    const ask = await raise(OWNER);
    await runStatus.turnStarted(OWNER);
    flips.length = 0;
    const flipStatus = store.flipStatus.bind(store);
    vi.spyOn(store, "flipStatus").mockImplementation(async (...args) => {
      await Promise.resolve();
      return flipStatus(...args);
    });

    // When
    const a = runStatus.turnEnded(OWNER);
    const b = runStatus.turnStarted(OWNER);
    await Promise.all([a, b]);

    // Then
    expect(statusOf(ask.id)).toMatchObject({ status: "in_progress", autoStatus: true });
    expect(flips).toMatchObject([
      { cause: "turn_ended", askId: ask.id, from: "in_progress", to: "open" },
      { cause: "turn_started", askId: ask.id, from: "open", to: "in_progress" },
    ]);
  });

  it("Given an owner event rejects, when the next event runs, then it still updates the ask", async () => {
    // Given
    const ask = await raise(OWNER);
    vi.spyOn(store, "flipStatus").mockRejectedValueOnce(new Error("write failed"));

    // When
    const failed = runStatus.turnStarted(OWNER);
    const next = runStatus.turnStarted(OWNER);
    await expect(failed).rejects.toThrow("write failed");
    await next;

    // Then
    expect(statusOf(ask.id)).toMatchObject({ status: "in_progress", autoStatus: true });
    expect(flips).toMatchObject([{ cause: "turn_started", askId: ask.id, from: "open", to: "in_progress" }]);
  });

  it("never touches done or dropped asks", async () => {
    const done = await raise(OWNER, "done");
    const dropped = await raise(OWNER, "dropped");
    await store.update(WS, done.id, { status: "done" });
    await store.update(WS, dropped.id, { status: "dropped", autoStatus: true });
    await runStatus.turnStarted(OWNER);
    await runStatus.turnEnded(OWNER);
    await runStatus.reconcile(async () => "running");
    expect(statusOf(done.id).status).toBe("done");
    expect(statusOf(dropped.id).status).toBe("dropped");
    expect(flips).toEqual([]);
  });

  it("ask_create stores in_progress auto, and the next turn end opens it", async () => {
    const result = await service.callTool(OWNER, "ask_create", { kind: "followup", title: "Look at this" });
    expect(result.text).toMatch(/^A1 \[in_progress\]/);
    expect(statusOf("A1")).toMatchObject({ status: "in_progress", autoStatus: true });
    expect(flips).toMatchObject([{ cause: "owner_call", askId: "A1", from: "open", to: "in_progress" }]);

    await runStatus.turnEnded(OWNER);
    expect(statusOf("A1").status).toBe("open");
    expect(flips.at(-1)).toMatchObject({ cause: "turn_ended", from: "in_progress", to: "open" });
  });

  it("an owner's ask_update to open mid-turn stores in_progress auto; its in_progress is sticky", async () => {
    await service.callTool(OWNER, "ask_create", { kind: "followup", title: "Look at this" });
    await runStatus.turnEnded(OWNER);
    flips.length = 0;

    await service.callTool(OWNER, "ask_update", { id: "A1", status: "open" });
    expect(statusOf("A1")).toMatchObject({ status: "in_progress", autoStatus: true });
    expect(flips).toMatchObject([{ cause: "owner_call", from: "open", to: "in_progress" }]);

    await service.callTool(OWNER, "ask_update", { id: "A1", status: "in_progress" });
    expect(statusOf("A1")).toMatchObject({ status: "in_progress", autoStatus: false });
    await runStatus.turnEnded(OWNER);
    expect(statusOf("A1").status).toBe("in_progress");
  });

  it("a non-owner's ask_update keeps today's behavior", async () => {
    const ask = await raise(OWNER);
    await service.callTool(OTHER, "ask_update", { id: ask.id, status: "in_progress" });
    expect(statusOf(ask.id).autoStatus).toBeUndefined();
    expect(flips).toEqual([]);
  });

  it("reconcile reverts an auto ask whose owner is idle and flips an open ask whose owner is running", async () => {
    const stale = await raise(OWNER, "stale");
    const missed = await raise(OTHER, "missed");
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
    expect([...lookups].sort()).toEqual([OWNER, OTHER]);
    expect(flips).toMatchObject([
      { cause: "reconcile", askId: stale.id, from: "in_progress", to: "open" },
      { cause: "reconcile", askId: missed.id, from: "open", to: "in_progress" },
    ]);
  });

  it("Given a reconcile and a turn start for the same owner overlap, when both settle, then the ask is in_progress", async () => {
    // Given
    const ask = await raise(OWNER);
    await runStatus.turnStarted(OWNER);
    flips.length = 0;
    const flipStatus = store.flipStatus.bind(store);
    vi.spyOn(store, "flipStatus").mockImplementation(async (...args) => {
      await Promise.resolve();
      return flipStatus(...args);
    });

    // When
    const a = runStatus.reconcile(async () => "idle");
    const b = runStatus.turnStarted(OWNER);
    await Promise.all([a, b]);

    // Then
    expect(statusOf(ask.id)).toMatchObject({ status: "in_progress", autoStatus: true });
    expect(flips).toMatchObject([
      { cause: "reconcile", askId: ask.id, from: "in_progress", to: "open" },
      { cause: "turn_started", askId: ask.id, from: "open", to: "in_progress" },
    ]);
  });
});
