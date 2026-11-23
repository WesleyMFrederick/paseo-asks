import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox } from "../server/outbox";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";
import { RunStatus } from "../server/run-status";
import type { Ask } from "../shared/asks";
import { attentionForOpenAsks } from "../server/schedule-attention";

function ask(overrides: Partial<Ask>): Ask {
  return {
    id: "A1",
    workspaceId: "w1",
    ownerAgentId: "agent-1",
    kind: "followup",
    title: "Rebase #367 manually",
    actions: [],
    links: [],
    status: "open",
    createdAt: "2026-11-15T08:00:00Z",
    updatedAt: "2026-11-15T08:00:00Z",
    ...overrides,
  };
}

describe("attentionForOpenAsks", () => {
  it("flags a run whose agent left asks waiting on you, naming the newest", () => {
    const asks = [
      ask({}),
      ask({ id: "A2", title: "Land draft PR #103", createdAt: "2026-11-15T09:00:00Z" }),
    ];
    expect(attentionForOpenAsks(asks, "agent-1")).toEqual({
      reason: "plugin",
      message: "2 open asks: Land draft PR #103",
    });
  });

  it("keeps a scheduled workspace before a new ask's delayed or missed turn-end flip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "asks-schedule-"));
    const store = new AskStore(dir);
    const service = new AsksService(
      store,
      new Outbox(dir, { state: async () => "idle", send: async () => undefined }),
      async () => "w1",
    );
    await service.callTool("agent-1", "ask_create", { kind: "question", title: "Approve the release?" });
    expect(store.get("w1", "A1")).toMatchObject({ status: "in_progress", autoStatus: true });
    const attention = { reason: "plugin", message: "1 open ask: Approve the release?" };
    expect(attentionForOpenAsks(store.list("w1"), "agent-1")).toEqual(attention);
    await new RunStatus(store, () => undefined).turnEnded("agent-1");
    expect(attentionForOpenAsks(store.list("w1"), "agent-1")).toEqual(attention);
  });

  it("counts automatic holds with open asks but not explicit holds or another owner's asks", () => {
    expect(attentionForOpenAsks([
      ask({}),
      ask({ id: "A2", status: "in_progress", autoStatus: true, title: "Approve", createdAt: "2026-11-15T09:00:00Z" }),
      ask({ id: "A3", status: "in_progress", autoStatus: false }),
      ask({ id: "A4", status: "in_progress", autoStatus: true, ownerAgentId: "other" }),
    ], "agent-1")).toEqual({ reason: "plugin", message: "2 open asks: Approve" });
  });

  it("ignores asks the agent is still working on, closed asks and other agents' asks", () => {
    const asks = [
      ask({ status: "in_progress" }),
      ask({ status: "done", autoStatus: true }),
      ask({ status: "dropped", autoStatus: true }),
      ask({ ownerAgentId: "agent-2" }),
    ];
    expect(attentionForOpenAsks(asks, "agent-1")).toBeNull();
  });
});
