import type { Ask } from "../shared/asks";
import type { AskStore } from "./store";

/** One line per automatic status flip. */
export interface FlipLogEntry {
  at: string;
  cause: "turn_started" | "turn_ended" | "owner_call" | "reconcile";
  workspaceId: string;
  askId: string;
  ownerAgentId: string;
  from: Ask["status"];
  to: Ask["status"];
}

export type OwnerState = "running" | "idle" | "gone";

/** Keeps an ask `in_progress` while its owner runs a turn and `open` while the owner is idle. */
export class RunStatus {
  constructor(
    private readonly store: AskStore,
    private readonly log: (entry: FlipLogEntry) => void,
  ) {}

  /** The owner started a turn: its open asks become in_progress (automatic). */
  async turnStarted(agentId: string): Promise<void> {
    for (const ask of this.store.list()) {
      if (ask.ownerAgentId === agentId && ask.status === "open") await this.flip(ask, "in_progress", true, "turn_started");
    }
  }

  /** The owner's turn ended: asks it did not hold in_progress by choice go back to open. */
  async turnEnded(agentId: string): Promise<void> {
    for (const ask of this.store.list()) {
      if (ask.ownerAgentId === agentId && ask.status === "in_progress" && ask.autoStatus) {
        await this.flip(ask, "open", false, "turn_ended");
      }
    }
  }

  /** Repairs missed events and plugin reloads from the owners' real state. One lookup per owner. */
  async reconcile(state: (agentId: string) => Promise<OwnerState>): Promise<void> {
    const states = new Map<string, Promise<OwnerState>>();
    for (const ask of this.store.list()) {
      const auto = ask.status === "in_progress" && ask.autoStatus;
      if (ask.status !== "open" && !auto) continue;
      const lookup = states.get(ask.ownerAgentId) ?? state(ask.ownerAgentId);
      states.set(ask.ownerAgentId, lookup);
      const running = (await lookup) === "running";
      if (auto && !running) await this.flip(ask, "open", false, "reconcile");
      else if (ask.status === "open" && running) await this.flip(ask, "in_progress", true, "reconcile");
    }
  }

  private async flip(ask: Ask, to: Ask["status"], autoStatus: boolean, cause: FlipLogEntry["cause"]): Promise<void> {
    if (!await this.store.flipStatus(ask, to, autoStatus)) return;
    this.log({ at: new Date().toISOString(), cause, workspaceId: ask.workspaceId, askId: ask.id, ownerAgentId: ask.ownerAgentId, from: ask.status, to });
  }
}
