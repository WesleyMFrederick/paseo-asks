import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ACTION_KINDS, ASK_KINDS, ASK_STATUSES, OPEN_STATUSES, type Ask, type CloseInputSchema, type ReassignInputSchema, type RelayInputSchema } from "../shared/asks";
import { REFRESH } from "./nudge";
import type { Delivery as OutboxDelivery, Outbox } from "./outbox";
import type { FlipLogEntry } from "./run-status";
import type { AskStore, NewAsk } from "./store";

export const INSTRUCTIONS = `Asks are the human's list of what you need from them, shown in Paseo outside this chat, with buttons that answer you.
- Rule: never end a turn with a question, a choice or a request for the human in chat alone. Call ask_create first, then point to it ("see A3").
- Whenever you need the human — a PR to review or merge, a decision, approval of a follow-up, a manual step you cannot do (an OAuth click, a vendor console), or an answer — call ask_create, then refer to it by id in chat ("see A3"). Do not leave it only in the chat.
- One item per ask. title: the question or the move, one line. body (markdown): what is at stake, the facts, the options, your recommendation.
- Decisions: one "resolve" action per option (2-4), mark one recommended. PRs and follow-ups: "send" actions whose prompt is the exact instruction you want back ("Merge PR #30 with squash"); put the PR URL in links. Set subscribe: true on a PR ask to be told when it is merged or closed, its checks pass or fail, or its review decision changes.
- The human may talk an ask through in a side chat; its outcome reaches you as an [asks] message like any other answer.
- Answers arrive as messages starting with [asks]. Act on them. After finishing work a send action gave you, call ask_resolve.
- Keep asks true: ask_update when facts change, ask_resolve or status "dropped" when the human is no longer needed. Check ask_list before creating a duplicate.
- The plugin sets in_progress while you run and open when you are idle, so never flip open/in_progress by hand. Set in_progress only to mark work that continues across turns.
- Your own to-do list stays in your task tool. Asks are only for things whose next move is the human's.`;

const ActionInput = z.object({
  label: z.string().min(1).max(60),
  kind: z.enum(ACTION_KINDS),
  prompt: z.string().optional(),
  url: z.string().url().optional(),
  recommended: z.boolean().optional(),
});
const LinkInput = z.object({ label: z.string(), url: z.string().url() });

const CreateInput = z.object({
  kind: z.enum(ASK_KINDS),
  title: z.string().min(1).max(200),
  body: z.string().optional(),
  actions: z.array(ActionInput).max(8).default([]),
  links: z.array(LinkInput).default([]),
  subscribe: z.boolean().optional(),
});
const UpdateInput = z.object({
  id: z.string(),
  title: z.string().min(1).max(200).optional(),
  body: z.string().optional(),
  actions: z.array(ActionInput).max(8).optional(),
  links: z.array(LinkInput).optional(),
  status: z.enum(ASK_STATUSES).optional(),
  subscribe: z.boolean().optional(),
});
const ResolveInput = z.object({ id: z.string(), actionId: z.string().optional(), note: z.string().optional() });
const ListInput = z.object({
  status: z.enum(["open", "all"]).default("open"),
  scope: z.enum(["workspace", "mine"]).default("workspace"),
});

export const TOOLS = [
  {
    name: "ask_create",
    description: "Record something you need from the human (review, decision, approval, manual step, answer). Returns its id, e.g. A3.",
    inputSchema: z.toJSONSchema(CreateInput, { io: "input" }),
  },
  {
    name: "ask_update",
    description:
      "Change an ask you created: facts, options, links, or status (open, in_progress, done, dropped). The plugin sets open and in_progress from your run state; set in_progress only for work that continues across turns.",
    inputSchema: z.toJSONSchema(UpdateInput, { io: "input" }),
  },
  {
    name: "ask_resolve",
    description: "Close an ask once it no longer needs the human, e.g. after doing the work a send action gave you.",
    inputSchema: z.toJSONSchema(ResolveInput, { io: "input" }),
  },
  {
    name: "ask_list",
    description: "List asks in your workspace (or only yours). Defaults to open ones.",
    inputSchema: z.toJSONSchema(ListInput, { io: "input" }),
  },
];

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export type Delivery = "sent" | "queued" | "nobody";

export interface ActInput {
  workspaceId: string;
  id: string;
  verb: "action" | "done" | "drop" | "reply";
  actionId?: string;
  note?: string;
}

/** One line per human action on an ask, success or refusal. */
export interface ActLogEntry extends ActInput {
  at: string;
  ownerAgentId?: string;
  before?: Ask["status"];
  after?: Ask["status"];
  delivery?: Delivery;
  error?: string;
}

/** What the daemon says about an agent; "gone" means unknown or archived. */
export type OwnerState = "running" | "idle" | "closed" | "gone";

/** One line per admin move or close of an ask whose owner is closed, success or refusal. */
export interface AdminLogEntry {
  at: string;
  verb: "reassign" | "close";
  workspaceId: string;
  id: string;
  by: string;
  reason: string;
  /** Absent only when the ask was not found. */
  ownerAgentId?: string;
  ownerState?: OwnerState;
  toAgentId?: string;
  /** `workspaceId/id` of the ask after a reassign. */
  movedTo?: string;
  before?: Ask["status"];
  after?: Ask["status"];
  error?: string;
}

/** The ask's owner is running or idle; only the owner may close or hand off its ask. */
export class AskOwnerLiveError extends Error {
  override readonly name = "AskOwnerLiveError";
  constructor(detail: string) {
    super(`AskOwnerLiveError: ${detail}`);
  }
}

/** The agent an ask would move to is closed, gone, its current owner, or has no workspace. */
export class AskTargetNotLiveError extends Error {
  override readonly name = "AskTargetNotLiveError";
  constructor(detail: string) {
    super(`AskTargetNotLiveError: ${detail}`);
  }
}

/** The ask is already done or dropped. */
export class AskAlreadyClosedError extends Error {
  override readonly name = "AskAlreadyClosedError";
  constructor(detail: string) {
    super(`AskAlreadyClosedError: ${detail}`);
  }
}

/** No ask with that workspace and id. */
export class AskNotFoundError extends Error {
  override readonly name = "AskNotFoundError";
  constructor(detail: string) {
    super(`AskNotFoundError: ${detail}`);
  }
}

export class AsksService {
  constructor(
    private readonly store: AskStore,
    private readonly outbox: Outbox,
    private readonly workspaceOf: (agentId: string) => Promise<string | null>,
    private readonly log: (entry: ActLogEntry | AdminLogEntry) => void = () => {},
    private readonly flipLog: (entry: FlipLogEntry) => void = () => {},
    private readonly ownerState: (agentId: string) => Promise<OwnerState> = async () => "idle",
  ) {}

  async callTool(agentId: string | null, name: string, args: unknown): Promise<ToolResult> {
    try {
      if (!agentId) throw new Error("PASEO_AGENT_ID is not set for this agent, so the ask has no owner");
      const workspaceId = await this.workspaceOf(agentId);
      if (!workspaceId) throw new Error(`Agent ${agentId} has no workspace`);
      switch (name) {
        case "ask_create":
          return render(await this.create(workspaceId, agentId, CreateInput.parse(args)));
        case "ask_update": {
          const { id, ...patch } = UpdateInput.parse(args);
          const ask = this.require(workspaceId, id);
          checkActions(patch.actions ?? []);
          let applied: typeof patch & { autoStatus?: boolean } = patch;
          if (agentId === ask.ownerAgentId && (patch.status === "open" || patch.status === "in_progress")) {
            // The owner is mid-turn, so "open" means in_progress (automatic); its own in_progress is a deliberate hold.
            const auto = patch.status === "open";
            applied = { ...patch, status: "in_progress", autoStatus: auto };
          }
          const updated = await this.store.update(workspaceId, id, applied);
          if (applied.autoStatus && ask.status !== "in_progress") {
            this.flipLog({ at: updated.updatedAt, cause: "owner_call", workspaceId, askId: id, ownerAgentId: ask.ownerAgentId, from: ask.status, to: "in_progress" });
          }
          if (agentId !== ask.ownerAgentId && !ask.orphaned && patch.status && patch.status !== ask.status) {
            this.notify(ask, `[asks] ${ask.id} (${ask.title}) marked ${patch.status.replace("_", " ")} in a side chat.`);
          }
          return render(updated);
        }
        case "ask_resolve": {
          const { id, actionId, note } = ResolveInput.parse(args);
          const ask = this.require(workspaceId, id);
          const label = actionId ? ask.actions.find((action) => action.id === actionId)?.label : undefined;
          const outcome = { actionId, label, note, by: "agent" as const, at: new Date().toISOString() };
          const resolved = await this.store.update(workspaceId, id, { status: "done", outcome });
          // A side chat (or any other agent) closing someone else's ask: the owner must hear about it.
          if (agentId !== ask.ownerAgentId && !ask.orphaned) {
            const choice = label ? `: ${label}` : "";
            const summary = note ? ` Summary: ${note}` : "";
            this.notify(ask, `[asks] ${ask.id} (${ask.title}) resolved in a side chat${choice}.${summary}`);
          }
          return render(resolved);
        }
        case "ask_list": {
          const { status, scope } = ListInput.parse(args);
          const asks = this.store
            .list(workspaceId)
            .filter((ask) => status === "all" || OPEN_STATUSES.includes(ask.status))
            .filter((ask) => scope === "workspace" || ask.ownerAgentId === agentId);
          return { text: asks.length ? asks.map(summary).join("\n") : "No asks." };
        }
        default:
          throw new Error(`Unknown tool ${name}`);
      }
    } catch (error) {
      const text = error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error);
      return { text, isError: true };
    }
  }

  /**
   * A human disposes of an ask from the UI. Fails on an ask that is already closed. Returns how the
   * owning agent hears of it: "sent" now, "queued" until its current turn ends, or "nobody" (orphaned).
   */
  async act(input: ActInput): Promise<{ ask: Ask; delivery: Delivery }> {
    const before = this.store.get(input.workspaceId, input.id);
    try {
      const result = await this.disposeOf(input);
      this.log({ at: new Date().toISOString(), ...input, ownerAgentId: result.ask.ownerAgentId, before: before?.status, after: result.ask.status, delivery: result.delivery });
      return result;
    } catch (error) {
      this.log({ at: new Date().toISOString(), ...input, ownerAgentId: before?.ownerAgentId, before: before?.status, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async disposeOf(input: ActInput): Promise<{ ask: Ask; delivery: Delivery }> {
    const ask = this.require(input.workspaceId, input.id);
    if (!OPEN_STATUSES.includes(ask.status)) throw new Error(`${ask.id} is already ${ask.status}; nothing was changed or sent`);
    const note = input.note?.trim() || undefined;
    const at = new Date().toISOString();
    const head = `[asks] ${ask.id} (${ask.title})`;
    const noted = note ? ` Note from the human: "${note}"` : "";
    let next: Ask;
    let message: string;
    switch (input.verb) {
      case "action": {
        const action = ask.actions.find((candidate) => candidate.id === input.actionId);
        if (!action) throw new Error(`Ask ${ask.id} has no action ${input.actionId}`);
        if (action.kind === "open") throw new Error("Open actions run on the client");
        if (action.kind === "send") {
          // Checked and claimed under the store lock, so a concurrent second press is refused before anything is queued.
          next = await this.store.claimSend(ask.workspaceId, ask.id);
          message = `${head} "${action.label}": ${action.prompt ?? action.label}.${noted} When it is done, call ask_resolve for ${ask.id}.`;
        } else {
          const outcome = { actionId: action.id, label: action.label, note, by: "human" as const, at };
          next = await this.store.update(ask.workspaceId, ask.id, { status: "done", outcome });
          message = `${head} resolved: ${action.label}.${noted}`;
        }
        break;
      }
      case "done":
        next = await this.store.update(ask.workspaceId, ask.id, { status: "done", outcome: { note, by: "human", at } });
        message = `${head} marked done by the human.${noted}`;
        break;
      case "drop":
        next = await this.store.update(ask.workspaceId, ask.id, { status: "dropped", outcome: { note, by: "human", at } });
        message = `${head} dropped by the human; do not pursue it.${noted}`;
        break;
      case "reply":
        if (!note) throw new Error("A reply needs text");
        next = await this.store.update(ask.workspaceId, ask.id, {});
        message = `${head} reply from the human: "${note}". Update or resolve ${ask.id} accordingly.`;
        break;
    }
    if (ask.orphaned) return { ask: next, delivery: "nobody" };
    const sent = this.notify(ask, message);
    await this.outbox.flush(ask.ownerAgentId);
    const state = this.outbox.state(sent.id);
    return { ask: next, delivery: state === "sent" ? "sent" : state === "pending" ? "queued" : "nobody" };
  }

  /** Queue a message for the ask's owner; it goes out once the owner is between turns. */
  notify(ask: Ask, text: string): OutboxDelivery {
    const delivery = this.outbox.enqueue({ agentId: ask.ownerAgentId, workspaceId: ask.workspaceId, askId: ask.id, text });
    void this.outbox.flush(ask.ownerAgentId);
    return delivery;
  }

  /** Queue a message about asks in general. The same text already waiting is not queued twice. */
  message(agentId: string, workspaceId: string, text: string): void {
    if (this.outbox.pending(agentId).some((entry) => entry.text === text)) return;
    this.outbox.enqueue({ agentId, workspaceId, text });
  }

  /** The human asks an agent to bring its asks up to date. Returns whether it went out now or waits for the turn to end. */
  async refresh(agentId: string): Promise<{ sent: boolean }> {
    const workspaceId = await this.workspaceOf(agentId);
    if (!workspaceId) throw new Error(`Agent ${agentId} has no workspace`);
    this.message(agentId, workspaceId, REFRESH);
    await this.outbox.flush(agentId);
    return { sent: this.outbox.pending(agentId).length === 0 };
  }

  /**
   * The harness saw a reply in readerAgentId's chat point at these asks: mark each relayed to that agent, so its pill
   * lists them. An ask named twice counts once, at its first pointer. Every ask must be open or in progress and
   * non-orphaned; validation and merging happen under the store locks. The first pointer gets the newest time.
   * A request has one explicit batch; a repeat relay replaces the reader's entry without touching updatedAt.
   */
  async relay({ readerAgentId, asks }: z.output<typeof RelayInputSchema>): Promise<{ relayed: Pick<Ask, "workspaceId" | "id">[] }> {
    const unique = asks.filter((ask, index) => asks.findIndex((other) => other.workspaceId === ask.workspaceId && other.id === ask.id) === index);
    await this.store.relay(readerAgentId, unique, Date.now(), randomUUID());
    return { relayed: unique.map(({ workspaceId, id }) => ({ workspaceId, id })) };
  }

  /**
   * Move an open ask whose owner is closed or gone to a live (running or idle) agent, then tell that agent. Refuses,
   * changing nothing, when the owner is live, the target is not live or has no workspace, or the ask is closed or
   * missing. Another workspace gets a new ask and the old one is dropped with a note naming where it went.
   */
  async reassign({ workspaceId, id, toAgentId, reason, by }: z.output<typeof ReassignInputSchema>): Promise<{ moved: Ask; from: Ask }> {
    const base = { verb: "reassign" as const, workspaceId, id, by, reason, toAgentId };
    const before = this.store.get(workspaceId, id);
    const seen: { ownerState?: OwnerState } = {};
    try {
      const ask = this.requireOpen(workspaceId, id);
      const old = ask.ownerAgentId;
      seen.ownerState = await this.ownerState(old);
      this.requireOwnerClosed(ask, seen.ownerState);
      if (toAgentId === old) throw new AskTargetNotLiveError(`${workspaceId}/${id} is already owned by ${toAgentId}. Nothing was changed.`);
      const targetState = await this.ownerState(toAgentId);
      if (targetState !== "running" && targetState !== "idle") throw new AskTargetNotLiveError(`target ${toAgentId} is ${targetState}; pick a running or idle agent. Nothing was changed.`);
      const toWs = await this.workspaceOf(toAgentId);
      if (!toWs) throw new AskTargetNotLiveError(`target ${toAgentId} has no workspace. Nothing was changed.`);
      const result = await this.store.move({ workspaceId, id }, { workspaceId: toWs, ownerAgentId: toAgentId }, (movedId) =>
        `Moved to ${toWs}/${movedId} (owner ${old} closed) by ${by}: ${reason}`);
      const { moved } = result;
      const text = `[asks] ${moved.id} (${moved.title}) is now yours. It moved from ${workspaceId}/${id}, whose owner ${old} is closed. Reason from ${by}: ${reason}. Check its facts, then ask_update or ask_resolve it.`;
      this.outbox.enqueue({ agentId: toAgentId, workspaceId: toWs, askId: moved.id, text });
      void this.outbox.flush(toAgentId);
      this.log({ at: new Date().toISOString(), ...base, ownerAgentId: old, ownerState: seen.ownerState, movedTo: `${toWs}/${moved.id}`, before: ask.status, after: result.from.status });
      return result;
    } catch (error) {
      this.log({ at: new Date().toISOString(), ...base, ownerAgentId: before?.ownerAgentId, ownerState: seen.ownerState, before: before?.status, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Mark done an open ask whose owner is closed or gone, with the reason as its outcome. Tells nobody (the owner is
   * closed). Refuses, changing nothing, when the owner is live or the ask is closed or missing.
   */
  async close({ workspaceId, id, reason, by }: z.output<typeof CloseInputSchema>): Promise<{ ask: Ask }> {
    const base = { verb: "close" as const, workspaceId, id, by, reason };
    const before = this.store.get(workspaceId, id);
    const seen: { ownerState?: OwnerState } = {};
    try {
      const ask = this.requireOpen(workspaceId, id);
      seen.ownerState = await this.ownerState(ask.ownerAgentId);
      this.requireOwnerClosed(ask, seen.ownerState);
      const closed = await this.store.update(workspaceId, id, { status: "done", outcome: { note: reason, by: "agent", at: new Date().toISOString() } });
      this.log({ at: new Date().toISOString(), ...base, ownerAgentId: ask.ownerAgentId, ownerState: seen.ownerState, before: ask.status, after: closed.status });
      return { ask: closed };
    } catch (error) {
      this.log({ at: new Date().toISOString(), ...base, ownerAgentId: before?.ownerAgentId, ownerState: seen.ownerState, before: before?.status, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private requireOpen(workspaceId: string, id: string): Ask {
    const ask = this.store.get(workspaceId, id);
    if (!ask) throw new AskNotFoundError(`no ask ${workspaceId}/${id}. Nothing was changed.`);
    if (!OPEN_STATUSES.includes(ask.status)) throw new AskAlreadyClosedError(`${workspaceId}/${id} is already ${ask.status}. Nothing was changed.`);
    return ask;
  }

  private requireOwnerClosed(ask: Ask, state: OwnerState): void {
    if (state === "running" || state === "idle") {
      throw new AskOwnerLiveError(`${ask.workspaceId}/${ask.id} owner ${ask.ownerAgentId} is ${state}; ask it to close or hand off its own ask. Nothing was changed.`);
    }
  }

  private async create(workspaceId: string, agentId: string, input: z.output<typeof CreateInput>): Promise<Ask> {
    checkActions(input.actions);
    if (input.kind === "decision" && input.actions.filter((action) => action.kind === "resolve").length < 2) {
      throw new Error('A decision needs at least two "resolve" actions, one per option');
    }
    // The owner is mid-turn whenever it calls a tool, so a new ask starts in_progress (automatic).
    const ask: NewAsk = { ...input, workspaceId, ownerAgentId: agentId, status: "in_progress", autoStatus: true };
    const created = await this.store.create(ask);
    this.flipLog({ at: created.createdAt, cause: "owner_call", workspaceId, askId: created.id, ownerAgentId: agentId, from: "open", to: "in_progress" });
    return created;
  }

  private require(workspaceId: string, id: string): Ask {
    const ask = this.store.get(workspaceId, id);
    if (!ask) throw new Error(`No ask ${id} in this workspace`);
    return ask;
  }
}

function checkActions(actions: z.output<typeof ActionInput>[]): void {
  for (const action of actions) {
    if (action.kind === "open" && !action.url) throw new Error(`Action "${action.label}" is "open" but has no url`);
  }
  if (actions.filter((action) => action.recommended).length > 1) throw new Error("Recommend at most one action");
}

function summary(ask: Ask): string {
  return `${ask.id} [${ask.status}] ${ask.kind}: ${ask.title}`;
}

function render(ask: Ask): ToolResult {
  const actions = ask.actions.map((action) => `${action.id} ${action.kind} "${action.label}"`).join(", ");
  return { text: `${summary(ask)}${actions ? `\nactions: ${actions}` : ""}` };
}
