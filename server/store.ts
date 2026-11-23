import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPEN_STATUSES, prUrlOf } from "../shared/asks";
import type { Action, Ask } from "../shared/asks";

interface WorkspaceFile {
  nextId: number;
  asks: Ask[];
}

export type NewAsk = Pick<Ask, "workspaceId" | "ownerAgentId" | "kind" | "title" | "body" | "links" | "subscribe" | "heldReview" | "lastCall"> & Partial<Pick<Ask, "status" | "autoStatus">> & {
  actions: Omit<Action, "id">[];
};

export type AskPatch = Partial<
  Pick<Ask, "title" | "body" | "links" | "status" | "autoStatus" | "outcome" | "orphaned" | "ownerAgentId" | "subscribe" | "pr" | "discussionAgentId" | "discussionWorkspaceId" | "remindedAt" | "lastCall" | "relayedTo">
> & {
  actions?: Omit<Action, "id">[];
};

/** One JSON file per workspace. Single writer (the plugin process), so a per-file promise chain is enough. */
export class AskStore {
  private readonly dir: string;
  private readonly cache = new Map<string, WorkspaceFile>();
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Every workspace with a file. Read from disk once: this process is the only writer, and lists run on every poll. */
  private known: Set<string> | null = null;

  constructor(root: string, private readonly now: () => Date = () => new Date()) {
    this.dir = join(root, "workspaces");
    mkdirSync(this.dir, { recursive: true });
  }

  list(workspaceId?: string): Ask[] {
    const ids = workspaceId ? [workspaceId] : this.workspaceIds();
    return ids.flatMap((id) => this.read(id).asks);
  }

  get(workspaceId: string, id: string): Ask | undefined {
    return this.read(workspaceId).asks.find((ask) => ask.id === id);
  }

  create(input: NewAsk): Promise<Ask> {
    return this.mutate(input.workspaceId, (file) => {
      const at = this.now().toISOString();
      const ask: Ask = {
        ...input,
        id: `A${file.nextId++}`,
        actions: withIds(input.actions),
        status: input.status ?? "open",
        createdAt: at,
        updatedAt: at,
      };
      file.asks.push(ask);
      return ask;
    });
  }

  /** Numbers the workspace's next asks after `id` (e.g. A31 after A30), so they can't be mistaken for that ask. */
  reserveAfter(workspaceId: string, id: string): Promise<void> {
    const number = Number(id.replace(/^A/, ""));
    return this.mutate(workspaceId, (file) => {
      if (Number.isInteger(number)) file.nextId = Math.max(file.nextId, number + 1);
    });
  }

  /** `touch: false` for bookkeeping (a PR snapshot) that should not count as the ask changing. */
  update(workspaceId: string, id: string, patch: AskPatch, { touch = true } = {}): Promise<Ask> {
    return this.mutate(workspaceId, (file) => {
      const index = file.asks.findIndex((ask) => ask.id === id);
      if (index < 0) throw new Error(`No ask ${id} in this workspace`);
      const current = file.asks[index]!;
      const next: Ask = {
        ...current,
        ...patch,
        // New links naming a different (or no) PR make the cached snapshot stale; an explicit `pr` in the patch wins.
        ...(patch.links !== undefined && !Object.hasOwn(patch, "pr") && prUrlOf({ links: patch.links }) !== prUrlOf(current) ? { pr: undefined } : {}),
        actions: patch.actions ? withIds(patch.actions) : current.actions,
        updatedAt: touch ? this.now().toISOString() : current.updatedAt,
      };
      file.asks[index] = next;
      return next;
    });
  }

  /** Compare under the workspace lock; an asynchronous owner lookup must not undo newer human or owner changes. */
  flipStatus(expected: Ask, status: Ask["status"], autoStatus: boolean): Promise<Ask | null> {
    return this.mutate(expected.workspaceId, (file) => {
      const current = file.asks.find((ask) => ask.id === expected.id);
      if (!current || current.status !== expected.status || current.ownerAgentId !== expected.ownerAgentId ||
        current.updatedAt !== expected.updatedAt || current.autoStatus !== expected.autoStatus) return null;
      current.status = status;
      current.autoStatus = autoStatus;
      return current;
    });
  }

  /** Check the ask is still sendable and mark it sent inside the workspace lock; of two concurrent sends, one is refused. */
  claimSend(workspaceId: string, id: string, outcome?: Ask["outcome"]): Promise<Ask> {
    return this.mutate(workspaceId, (file) => {
      const current = file.asks.find((ask) => ask.id === id);
      if (!current) throw new Error(`No ask ${id} in this workspace`);
      if (!OPEN_STATUSES.includes(current.status)) throw new Error(`${id} is already ${current.status}; nothing was changed or sent`);
      if (current.status === "in_progress" && !current.autoStatus) throw new Error(`${id} send action was already sent; nothing was changed or sent`);
      current.status = "in_progress";
      current.autoStatus = false;
      current.outcome = outcome;
      current.updatedAt = this.now().toISOString();
      return current;
    });
  }

  /** Validate every target and merge stamps under all affected workspace locks; no target is written on refusal. */
  relay(readerAgentId: string, targets: readonly Pick<Ask, "workspaceId" | "id">[], at: number, batch: string): Promise<void> {
    return this.mutateWorkspaces([...new Set(targets.map((target) => target.workspaceId))], (files) => {
      const asks = targets.map(({ workspaceId, id }) => files.get(workspaceId)!.asks.find((ask) => ask.id === id));
      const missing = targets.filter((_, index) => !asks[index]).map(({ workspaceId, id }) => `${workspaceId}/${id}`);
      if (missing.length) throw new Error(`No ask ${missing.join(", ")}; nothing was relayed`);
      const ineligible = asks.filter((ask) => ask!.orphaned || !OPEN_STATUSES.includes(ask!.status));
      if (ineligible.length) throw new Error(`Ineligible asks ${ineligible.map((ask) => `${ask!.workspaceId}/${ask!.id}`).join(", ")}; nothing was relayed`);
      // Requests in the same millisecond still have an unambiguous newest batch.
      const newest = this.list().reduce((latest, ask) => {
        const entry = ask.relayedTo?.find((entry) => entry.agentId === readerAgentId);
        return entry ? Math.max(latest, Date.parse(entry.at) + 1) : latest;
      }, at);
      asks.forEach((ask, index) => {
        ask!.relayedTo = [
          ...(ask!.relayedTo?.filter((entry) => entry.agentId !== readerAgentId) ?? []),
          { agentId: readerAgentId, at: new Date(newest).toISOString(), batch, index },
        ];
      });
    });
  }

  /**
   * Hand an open ask to a new owner under both workspace locks. Same workspace: the ask keeps its id and gets the new
   * owner, open. Other workspace: a fresh open copy (next id there, same actions and links, no outcome, relays or side
   * chat) is created and the old ask is dropped with `note(newId)` as its outcome. Nothing is written on refusal.
   */
  move(from: Pick<Ask, "workspaceId" | "id">, to: { workspaceId: string; ownerAgentId: string }, note: (movedId: string) => string): Promise<{ moved: Ask; from: Ask }> {
    return this.mutateWorkspaces([...new Set([from.workspaceId, to.workspaceId])], (files) => {
      const source = files.get(from.workspaceId)!;
      const index = source.asks.findIndex((ask) => ask.id === from.id);
      if (index < 0) throw new Error(`No ask ${from.id} in this workspace`);
      const current = source.asks[index]!;
      if (!OPEN_STATUSES.includes(current.status)) throw new Error(`${from.id} is already ${current.status}; nothing was changed`);
      const at = this.now().toISOString();
      if (from.workspaceId === to.workspaceId) {
        const next: Ask = { ...current, ownerAgentId: to.ownerAgentId, status: "open", orphaned: undefined, autoStatus: undefined, updatedAt: at };
        source.asks[index] = next;
        return { moved: next, from: next };
      }
      const target = files.get(to.workspaceId)!;
      const moved: Ask = {
        id: `A${target.nextId++}`,
        workspaceId: to.workspaceId,
        ownerAgentId: to.ownerAgentId,
        kind: current.kind,
        title: current.title,
        body: current.body,
        actions: current.actions,
        links: current.links,
        subscribe: current.subscribe,
        heldReview: current.heldReview,
        pr: current.pr,
        status: "open",
        createdAt: at,
        updatedAt: at,
      };
      target.asks.push(moved);
      const dropped: Ask = { ...current, status: "dropped", outcome: { note: note(moved.id), by: "agent", at }, updatedAt: at };
      source.asks[index] = dropped;
      return { moved, from: dropped };
    });
  }

  private workspaceIds(): string[] {
    this.known ??= new Set(
      readdirSync(this.dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => decodeURIComponent(name.slice(0, -".json".length))),
    );
    return [...this.known];
  }

  private path(workspaceId: string): string {
    return join(this.dir, `${encodeURIComponent(workspaceId)}.json`);
  }

  private read(workspaceId: string): WorkspaceFile {
    const cached = this.cache.get(workspaceId);
    if (cached) return cached;
    const path = this.path(workspaceId);
    const file: WorkspaceFile = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { nextId: 1, asks: [] };
    this.cache.set(workspaceId, file);
    return file;
  }

  private mutate<T>(workspaceId: string, change: (file: WorkspaceFile) => T): Promise<T> {
    return this.mutateWorkspaces([workspaceId], (files) => change(files.get(workspaceId)!));
  }

  private mutateWorkspaces<T>(workspaceIds: readonly string[], change: (files: Map<string, WorkspaceFile>) => T): Promise<T> {
    const run = () => {
      const drafts = new Map(workspaceIds.map((id) => [id, structuredClone(this.read(id))]));
      const result = change(drafts);
      for (const [id, draft] of drafts) {
        const path = this.path(id);
        writeFileSync(`${path}.tmp`, JSON.stringify(draft, null, 2));
        renameSync(`${path}.tmp`, path);
        this.cache.set(id, draft);
        this.known?.add(id);
      }
      return result;
    };
    const next = Promise.all(workspaceIds.map((id) => this.locks.get(id))).then(run);
    for (const id of workspaceIds) this.locks.set(id, next.catch(() => undefined));
    return next;
  }
}

function withIds(actions: Omit<Action, "id">[]): Action[] {
  return actions.map((action, index) => ({ ...action, id: `a${index + 1}` }));
}
