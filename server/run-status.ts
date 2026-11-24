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
  private readonly ownerChains = new Map<string, Promise<void>>();

  constructor(
    private readonly store: AskStore,
    private readonly log: (entry: FlipLogEntry) => void,
  ) {}

  /** The owner started a turn: its open asks become in_progress (automatic). */
  async turnStarted(agentId: string): Promise<void> {
    await this.forOwner(agentId, async () => {
      for (const ask of this.store.list()) {
        if (ask.ownerAgentId === agentId && ask.status === "open") await this.flip(ask, "in_progress", true, "turn_started");
      }
    });
  }

  /** The owner's turn ended: asks it did not hold in_progress by choice go back to open. */
  async turnEnded(agentId: string): Promise<void> {
    await this.forOwner(agentId, async () => {
      for (const ask of this.store.list()) {
        if (ask.ownerAgentId === agentId && ask.status === "in_progress" && ask.autoStatus) {
          await this.flip(ask, "open", false, "turn_ended");
        }
      }
    });
  }

  /** Repairs missed events and plugin reloads from the owners' real state. One lookup per owner. */
  async reconcile(state: (agentId: string) => Promise<OwnerState>): Promise<void> {
    const owners = new Set<string>();
    for (const ask of this.store.list()) {
      if (ask.status === "open" || (ask.status === "in_progress" && ask.autoStatus)) owners.add(ask.ownerAgentId);
    }
    await Promise.all([...owners].map((agentId) => this.forOwner(agentId, async () => {
      const asks = this.store.list().filter((ask) => ask.ownerAgentId === agentId);
      const running = (await state(agentId)) === "running";
      for (const ask of asks) {
        const auto = ask.status === "in_progress" && ask.autoStatus;
        if (auto && !running) await this.flip(ask, "open", false, "reconcile");
        else if (ask.status === "open" && running) await this.flip(ask, "in_progress", true, "reconcile");
      }
    })));
  }

  /** Paseo fires lifecycle hooks without awaiting them, so turn_ended and the next turn_started can overlap. */
  private async forOwner(agentId: string, step: () => Promise<void>): Promise<void> {
    const previous = this.ownerChains.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(step);
    this.ownerChains.set(agentId, next);
    try {
      await next;
    } finally {
      if (this.ownerChains.get(agentId) === next) this.ownerChains.delete(agentId);
    }
  }

  private async flip(ask: Ask, to: Ask["status"], autoStatus: boolean, cause: FlipLogEntry["cause"]): Promise<void> {
    if (!await this.store.flipStatus(ask, to, autoStatus)) return;
    this.log({ at: new Date().toISOString(), cause, workspaceId: ask.workspaceId, askId: ask.id, ownerAgentId: ask.ownerAgentId, from: ask.status, to });
  }
}
