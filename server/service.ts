import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ACTION_KINDS, ASK_KINDS, ASK_STATUSES, OPEN_STATUSES, prUrlOf, type Ask, type CloseInputSchema, type PrState, type ReassignInputSchema, type RelayInputSchema } from "../shared/asks";
import { REFRESH } from "./nudge";
import { stuckReminder } from "../shared/prompts";
import { isStale, needsReminder } from "./stuck";
import { checkNotBundled } from "./bundle";
import { callKey } from "../shared/timeline";
import type { Delivery as OutboxDelivery, Outbox } from "./outbox";
import type { AskStore, NewAsk } from "./store";
import type { PathCheck } from "./file-paths";
import type { FlipLogEntry } from "./run-status";

const ADDRESS_REVIEW = `  - "CHANGES_REQUESTED": address the comments, or report what you will not change, and push. Then ask_update the same ask with a send action to re-request the review, not a Merge action.`;
const HOLD_REVIEW = `  - "CHANGES_REQUESTED": the human decides when the review is worked. Do not start on it yourself: Paseo raises an "Address review comments on PR #N" ask, and its button sends you the work. Do not give your own asks an action that starts the review; that ask carries it. When its prompt arrives, address the comments, or report what you will not change, push, and ask_update the PR ask with a send action to re-request the review, not a Merge action. Comments on an approved PR raise no such ask: list them in the PR ask's body and add an "Address review comments" send action next to Merge.`;

/** The agent's standing rules. With review changes held, an agent that sees CHANGES_REQUESTED itself must wait for the human too. */
export const instructions = ({ actOnReviewChanges = true } = {}) => `Asks are the human's list of what you need from them, shown in Paseo outside this chat, with buttons that answer you.
- Rule: never end a turn with a question, a choice or a request for the human in chat alone. Record it with ask_create.
- Whenever you need the human — reviewers or a merge for a PR, a decision, approval of a follow-up, a manual step you cannot do (an OAuth click, a vendor console), or an answer — call ask_create. Do not leave it only in the chat. When a reply mentions an ask from an earlier turn, name it by id ("still waiting on A3").
- Put deferred or out-of-scope work in the work queue, not in asks. Create asks only when you need a human answer or action; your own future work belongs in the work queue. Respect instructions not to offer follow-up work.
- Create or update your asks before your final reply, then end the turn with that reply: your summary and explanation, naming the ask by id where it helps ("A3 has the options"). The ask and its buttons appear in the chat where you call it. A collapsed turn shows only its last message, so the turn must end on your answer, not on the ask or a line pointing to it.
- One item per ask. title: the question or the move, one line. body (markdown): what is at stake, the facts, the options, your recommendation.
- Write for someone who hasn't seen the work: open the body with "Simply put:" and a concrete example, and keep file paths and internal codes (ticket or spec ids) out of titles; PR numbers are fine. When the decision is about structure or flow, add a mermaid diagram.
- Several open questions (a spec's open questions, a list of decisions) are several asks: create one per question, each with its own options, so the human answers them one by one. Never bundle them into one ask with "Accept all" or "answer in chat"; put the shared context in each body in a line or two.
- Decisions: one "resolve" action per option (2-4), mark one recommended. PRs and follow-ups: "send" actions whose prompt is the exact instruction you want back ("Merge PR #30 with squash"); put the PR URL in links. Set subscribe: true on a PR ask to be told when it is merged or closed, its checks pass or fail, or its review decision changes.
- Action labels: a short verb and its object ("Merge (squash)", "Request review from alice"). Leave out the PR number and the ask id: the card shows them. Mark the one you recommend with recommended: true, not with a star in the label.
- Clicking an action is the human acting, not you. Anything you were told to leave to the human (merge, deploy, delete, publish, spend) belongs in an ask as a send action, not left out: "the human merges" means they click it.
- Never make the human wait to click. When the move depends on something you can watch (a merge, a release, CI, another agent), offer it now as a conditional approval ("Start once #12 is merged and released", not "Start (#12 merged and released)"); on the click, keep the ask in progress, wait yourself, then act.
- PRs: one subscribed ask per PR, shaped by gh pr view --json reviewDecision,statusCheckRollup. While checks are pending, offer each Merge action below as "… when green" with a prompt saying so ("Merge PR #30 with squash once checks pass"); on that click, keep the ask in progress and merge when your subscription reports the checks passing. While checks fail, offer no Merge action: fix them and push.
  - Before any Merge action, read every review body and comment from people, approvals included; skip bot status comments (CI summaries, preview-deploy notices). Use gh pr view N --json reviews,comments for review bodies and top-level comments, and gh api --paginate repos/OWNER/REPO/pulls/N/comments for inline ones. Resolved threads don't count (reviewThreads { isResolved } through gh api graphql tells which). An approval often carries suggestions, questions or "fix before merging": handle them like requested changes (see "CHANGES_REQUESTED"), except that afterwards you offer Merge, naming what changed in the ask body, not a re-review, unless the reviewer asked to look again. Quote any you leave unaddressed in the ask body, with why.
  - Empty or "APPROVED", checks passing or pending, every comment read: the PR is ready. A "Merge" send action, and no review ask.
  - "REVIEW_REQUIRED": the human's move is choosing who reviews it. Title it "Request review on PR #N", with one send action per candidate reviewer (2-4, from CODEOWNERS, recent reviewers of the touched files, or collaborators; recommend one), each prompt naming who ("Request review on PR #30 from alice"). If the human can merge past the review (gh api graphql -f query='{repository(owner:"OWNER",name:"REPO"){pullRequest(number:N){viewerCanMergeAsAdmin}}}' is true), add a send action "Merge with --admin" next to them.
${actOnReviewChanges ? ADDRESS_REVIEW : HOLD_REVIEW}
  - Request or re-request a review only when the human clicks. Doing it does not finish the ask: keep it in progress, not resolved, so its subscription tells you about the review. Once the review is approved and checks pass, read the review and its comments as above, then ask_update the same ask to a "Merge" send action.
- The human may talk an ask through in a side chat; its outcome reaches you as an [asks] message like any other answer.
- Answers arrive as messages starting with [asks]. Act on them. After finishing work a send action gave you, call ask_resolve (a requested PR review is not finished until it is approved; see PRs).
- The plugin sets in_progress while you run and open when you are idle. Set in_progress explicitly only for work that continues across turns. A human send action also holds the ask in progress until you finish it or offer fresh actions with ask_update. Fresh actions hand it back to the human when your turn ends unless you explicitly set in_progress in that update; never point them to a button on a held in-progress ask. In chat, use these names: "waiting on you" for open, "in progress" for in_progress.
- Keep asks true: ask_update when facts change, ask_resolve or status "dropped" when the human is no longer needed. Check ask_list before creating a duplicate.
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
  status: z.enum(["active", "open", "all"]).default("active"),
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
    description: "Change an ask you created: facts, options, links, or status (open, in_progress, done, dropped). The plugin sets open and in_progress from your run state; set in_progress only for work that continues across turns.",
    inputSchema: z.toJSONSchema(UpdateInput, { io: "input" }),
  },
  {
    name: "ask_resolve",
    description: "Close an ask once it no longer needs the human, e.g. after doing the work a send action gave you.",
    inputSchema: z.toJSONSchema(ResolveInput, { io: "input" }),
  },
  {
    name: "ask_list",
    description: "List asks in your workspace (or only yours). Defaults to active ones: open (waiting on the human) or in_progress (yours).",
    inputSchema: z.toJSONSchema(ListInput, { io: "input" }),
  },
];

export interface ToolResult {
  text: string;
  isError?: boolean;
  /** The ask the call created or changed. */
  ask?: Pick<Ask, "workspaceId" | "id">;
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
/** What an agent in a background workspace gets back instead of an ask. */
export const BACKGROUND_SKIP =
  "Skipped: this workspace runs in the background (an automated run hidden from the sidebar), so nobody reads asks here. Put what you have in your final reply. Asks work again once the human opens this chat.";

export class AsksService {
  constructor(
    private readonly store: AskStore,
    private readonly outbox: Outbox,
    private readonly workspaceOf: (agentId: string) => Promise<string | null>,
    /**
     * Background workspaces (hidden from the sidebar, e.g. Inbox review runs) get no asks: nobody watches them, and
     * whatever the run produced already shows where it was started from. The tool stays, since an agent's tools are
     * fixed when it is created and the human may take the run over later.
     */
    private readonly isBackground: (workspaceId: string) => Promise<boolean> = async () => false,
    /** Makes file paths in a body open from the workspace; see file-paths.ts. */
    private readonly checkPaths: (workspaceId: string, body: string) => Promise<PathCheck> = async (_, body) => ({ body, notes: [] }),
    private readonly log: (entry: ActLogEntry | AdminLogEntry) => void = () => {},
    private readonly ownerState: (agentId: string) => Promise<OwnerState> = async () => "idle",
    private readonly flipLog: (entry: FlipLogEntry) => void = () => {},
  ) {}

  async callTool(agentId: string | null, name: string, args: unknown): Promise<ToolResult> {
    try {
      if (!agentId) throw new Error("PASEO_AGENT_ID is not set for this agent, so the ask has no owner");
      const workspaceId = await this.workspaceOf(agentId);
      if (!workspaceId) throw new Error(`Agent ${agentId} has no workspace`);
      if (await this.isBackground(workspaceId)) return { text: BACKGROUND_SKIP };
      switch (name) {
        case "ask_create": {
          const input = CreateInput.parse(args);
          const paths = await this.paths(workspaceId, input.body);
          const lastCall = callKey("create", args);
          return render(await this.create(workspaceId, agentId, { ...input, body: paths.body }, lastCall), paths.notes);
        }
        case "ask_update": {
          const { id, ...patch } = UpdateInput.parse(args);
          this.checkStillWaiting(this.find(workspaceId, agentId, id), agentId);
          const paths = await this.paths(this.find(workspaceId, agentId, id).workspaceId, patch.body);
          if (patch.body !== undefined) patch.body = paths.body;
          // Read again after the path check (git, seconds): a human click meanwhile must not be overwritten.
          const ask = this.find(workspaceId, agentId, id);
          this.checkStillWaiting(ask, agentId);
          checkActions(patch.actions ?? []);
          if (patch.title !== undefined) checkNotBundled(patch.title);
          // Fresh options without an explicit status release a held ask back to the human at turn end.
          // Not while the human's answer still waits in the outbox: the agent doesn't know what was clicked.
          const unseenAnswer = this.outbox.pending(ask.ownerAgentId).some((entry) => entry.askId === ask.id);
          if (patch.actions?.length && patch.status === undefined && ask.status === "in_progress" && !unseenAnswer) {
            patch.status = "open";
          }
          // Reopened by its owner: the old discussion was about what it asked then. Discuss starts a new one.
          const reopened = !OPEN_STATUSES.includes(ask.status) && patch.status !== undefined && OPEN_STATUSES.includes(patch.status);
          const unlink = reopened && ask.discussionAgentId ? { discussionAgentId: undefined, discussionWorkspaceId: undefined } : {};
          // The owner is mid-turn. An open request is automatic; explicit in_progress holds across turns,
          // even with fresh options. Other updates preserve a human send or explicit hold.
          const applied = agentId === ask.ownerAgentId && (patch.status === "open" || patch.status === "in_progress")
            ? { ...patch, status: "in_progress" as const, autoStatus: patch.status === "open" }
            : patch;
          const updated = await this.store.update(ask.workspaceId, id, { ...applied, ...unlink, lastCall: callKey("update", args) });
          if ("autoStatus" in applied && applied.autoStatus && ask.status !== "in_progress") {
            this.flipLog({ at: updated.updatedAt, cause: "owner_call", workspaceId: ask.workspaceId, askId: id, ownerAgentId: ask.ownerAgentId, from: ask.status, to: "in_progress" });
          }
          if (agentId !== ask.ownerAgentId && !ask.orphaned && patch.status && patch.status !== ask.status) {
            this.notify(ask, `[asks] ${ask.id} (${ask.title}) marked ${patch.status.replace("_", " ")} in a side chat.`);
          }
          return render(updated, paths.notes);
        }
        case "ask_resolve": {
          const { id, actionId, note } = ResolveInput.parse(args);
          const ask = this.find(workspaceId, agentId, id);
          this.checkStillWaiting(ask, agentId);
          const label = actionId ? ask.actions.find((action) => action.id === actionId)?.label : undefined;
          const outcome = { actionId, label, note, by: "agent" as const, at: new Date().toISOString() };
          const resolved = await this.store.update(ask.workspaceId, id, { status: "done", outcome, lastCall: callKey("resolve", args) });
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
          // An explainer in its own workspace also sees the ask it discusses.
          const linked = this.discussing(agentId).filter((ask) => ask.workspaceId !== workspaceId);
          const asks = [...linked, ...this.store.list(workspaceId)]
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
          // The card shows what you chose while the agent works on it.
          const outcome = { actionId: action.id, label: action.label, note, by: "human" as const, at };
          // Checked and claimed under the store lock, so a concurrent second press is refused before anything is queued.
          next = await this.store.claimSend(ask.workspaceId, ask.id, outcome);
          // Resolving drops the ask from the PR watcher, so a review request resolved here would never hear the approval.
          const watched = ask.subscribe && prUrlOf(ask) ? " If the PR then waits on someone other than the human (CI, a reviewer you requested), keep the ask in progress instead of resolving it: resolving ends its PR updates. If it waits on the human (a label, an approval, a merge only they can do), ask_update it with the action they need, which sets it back to open." : "";
          message = `${head} "${action.label}": ${action.prompt ?? action.label}.${noted} When it is done, call ask_resolve for ${ask.id}.${watched}`;
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
        // A reply adds context without choosing an action or changing who holds the ask.
        next = await this.store.update(ask.workspaceId, ask.id, { outcome: { note, by: "human", at } });
        message = `${head} reply from the human: "${note}". Update or resolve ${ask.id} accordingly.`;
        break;
    }
    this.tellDiscussion(ask, input.verb, input.actionId);
    if (ask.orphaned) return { ask: next, delivery: "nobody" };
    const sent = this.notify(ask, message);
    await this.outbox.flush(ask.ownerAgentId);
    const state = this.outbox.state(sent.id);
    return { ask: next, delivery: state === "sent" ? "sent" : state === "pending" ? "queued" : "nobody" };
  }

  /**
   * The human answered with a button, which may be in the explainer's workspace: the agent discussing the ask must
   * know, or it settles the ask a second time. No askId, so an explainer that is gone leaves the ask alone.
   */
  private tellDiscussion(ask: Ask, verb: "action" | "done" | "drop" | "reply", actionId?: string): void {
    const agentId = ask.discussionAgentId;
    if (!agentId || agentId === ask.ownerAgentId || verb === "reply") return;
    const action = ask.actions.find((candidate) => candidate.id === actionId);
    const what = verb === "done" ? "marked it done" : verb === "drop" ? "dropped it" : `chose "${action?.label ?? actionId}"`;
    const told = ask.orphaned ? "Nobody else was told: the agent that raised it is gone." : "The main agent has been told.";
    this.message(
      agentId,
      ask.discussionWorkspaceId ?? ask.workspaceId,
      `[asks] The human answered ${ask.id} (${ask.title}) with its buttons: they ${what}. ${told} Do not resolve or update ${ask.id}. Reply in one line.`,
    );
    void this.outbox.flush(agentId);
  }

  /**
   * A discussion settles an ask only while it waits on the human. Once the human answered (a choice, or work handed
   * to the owner), another settle would overwrite the answer, tell the owner twice, or end the owner's PR updates.
   */
  private checkStillWaiting(ask: Ask, agentId: string): void {
    if (agentId !== ask.discussionAgentId || agentId === ask.ownerAgentId || ask.status === "open" || (ask.status === "in_progress" && ask.autoStatus)) return;
    const outcome = ask.outcome?.label ? `: ${ask.outcome.label}` : "";
    const holder = ask.orphaned ? "its agent is gone" : "the main agent has it";
    throw new Error(`${ask.id} no longer waits on the human (${ask.status.replace("_", " ")}${outcome}); ${holder}. Leave it as it is.`);
  }

  /** Queue a message for the ask's owner; it goes out once the owner is between turns. */
  notify(ask: Ask, text: string): OutboxDelivery {
    const delivery = this.outbox.enqueue({ agentId: ask.ownerAgentId, workspaceId: ask.workspaceId, askId: ask.id, text });
    void this.outbox.flush(ask.ownerAgentId);
    return delivery;
  }

  /** The owner ended a turn holding in-progress asks that wait on nobody else: one reminder per change of each. */
  async remindStuck(agentId: string, workspaceId: string): Promise<void> {
    const stuck = this.store.list(workspaceId).filter((ask) => ask.ownerAgentId === agentId && needsReminder(ask));
    if (!stuck.length) return;
    const at = new Date().toISOString();
    for (const ask of stuck) await this.store.update(workspaceId, ask.id, { remindedAt: at }, { touch: false });
    this.message(agentId, workspaceId, stuckReminder(stuck));
  }

  /** Hand the owner's in-progress asks back to the human: it is gone, so nobody is working on them. */
  async releaseOwner(agentId: string): Promise<Ask[]> {
    const held = this.store.list().filter((ask) => ask.ownerAgentId === agentId && ask.status === "in_progress");
    return Promise.all(held.map((ask) => this.store.update(ask.workspaceId, ask.id, { status: "open", autoStatus: false })));
  }

  /** Recover stale automatic holds only; a human send or explicit hold has no expiry. */
  async reopenStale(isRunning: (agentId: string) => Promise<boolean>, now = new Date()): Promise<Ask[]> {
    const running = new Map<string, boolean>();
    const reopened: Ask[] = [];
    for (const ask of this.store.list()) {
      if (ask.status !== "in_progress" || !ask.autoStatus) continue;
      if (!running.has(ask.ownerAgentId)) running.set(ask.ownerAgentId, await isRunning(ask.ownerAgentId).catch(() => true));
      if (isStale(ask, now, running.get(ask.ownerAgentId)!)) {
        const updated = await this.store.flipStatus(ask, "open", false);
        if (updated) reopened.push(updated);
      }
    }
    return reopened;
  }

  /** Queue a message about asks in general. The same text already waiting is not queued twice. */
  message(agentId: string, workspaceId: string, text: string): void {
    if (this.outbox.pending(agentId).some((entry) => entry.text === text)) return;
    this.outbox.enqueue({ agentId, workspaceId, text });
  }

  /** The human asks an agent to bring its asks up to date. Returns whether it went out now (steered into a running turn when possible) or waits for the turn to end. */
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

  /**
   * Requested changes the human holds back: an ask whose button starts the work, owned by the PR ask's agent.
   * One per round: a closed one comes back only when `newRound` (the review moved into changes requested again).
   */
  async raiseReview(prAsk: Ask, pr: PrState, { newRound }: { newRound: boolean }): Promise<Ask | null> {
    const raised = this.store
      .list(prAsk.workspaceId)
      // Another or a gone owner's ask can't take the work, so the button must reach this owner.
      .filter((ask) => ask.heldReview && ask.ownerAgentId === prAsk.ownerAgentId && !ask.orphaned && prUrlOf(ask) === pr.url);
    const open = raised.find((ask) => OPEN_STATUSES.includes(ask.status));
    if (open) return open;
    if (raised.length && !newRound) return null;
    const title = `Address review comments on PR #${pr.number}`;
    return this.store.create({
      heldReview: true,
      workspaceId: prAsk.workspaceId,
      ownerAgentId: prAsk.ownerAgentId,
      kind: "followup",
      title,
      body: `A reviewer requested changes on PR #${pr.number}. The agent has not been told: it starts on them when you press **Address review comments**.`,
      links: [{ label: `PR #${pr.number}`, url: pr.url }],
      actions: [{ label: "Address review comments", kind: "send", prompt: `Address the review comments on PR #${pr.number} (${pr.url}) and push` }],
    });
  }

  private async create(workspaceId: string, agentId: string, input: z.output<typeof CreateInput>, lastCall: string): Promise<Ask> {
    checkActions(input.actions);
    checkNotBundled(input.title);
    if (input.kind === "decision" && input.actions.filter((action) => action.kind === "resolve").length < 2) {
      throw new Error('A decision needs at least two "resolve" actions, one per option');
    }
    // Tool calls happen mid-turn; turn end returns automatically held asks to the human.
    const ask: NewAsk = { ...input, workspaceId, ownerAgentId: agentId, lastCall, status: "in_progress", autoStatus: true };
    const created = await this.store.create(ask);
    this.flipLog({ at: created.createdAt, cause: "owner_call", workspaceId, askId: created.id, ownerAgentId: agentId, from: "open", to: "in_progress" });
    return created;
  }

  /** A failed check never blocks the ask: the body goes through as written. */
  private async paths(workspaceId: string, body: string | undefined): Promise<{ body: string | undefined; notes: string[] }> {
    if (!body) return { body, notes: [] };
    try {
      return await this.checkPaths(workspaceId, body);
    } catch (error) {
      console.error("[asks] could not check file paths", error);
      return { body, notes: [] };
    }
  }

  /** Ids a reply may name to show its wait is recorded: the workspace's open asks, and the open ask the agent explains. */
  openAskIds(agentId: string, workspaceId: string): Set<string> {
    return new Set(
      [...this.store.list(workspaceId), ...this.discussing(agentId)]
        .filter((ask) => OPEN_STATUSES.includes(ask.status))
        .map((ask) => ask.id),
    );
  }

  /** The discussion agent is archived: its asks drop the link, so their cards stop pointing at it and Discuss starts afresh. */
  async endDiscussion(agentId: string): Promise<Ask[]> {
    return Promise.all(
      this.discussing(agentId).map((ask) =>
        this.store.update(ask.workspaceId, ask.id, { discussionAgentId: undefined, discussionWorkspaceId: undefined }, { touch: false }),
      ),
    );
  }

  /** Asks this agent was opened to discuss, in any workspace. */
  discussing(agentId: string): Ask[] {
    return this.store.list().filter((ask) => ask.discussionAgentId === agentId);
  }

  /**
   * The ask an agent's call names. The one it was opened to discuss comes first, wherever it lives: an explainer works
   * from a workspace of its own. Only that link reaches across workspaces.
   */
  private find(workspaceId: string, agentId: string, id: string): Ask {
    return this.discussing(agentId).find((ask) => ask.id === id) ?? this.require(workspaceId, id);
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

function render(ask: Ask, notes: string[] = []): ToolResult {
  const actions = ask.actions.map((action) => `${action.id} ${action.kind} "${action.label}"`).join(", ");
  const paths = notes.length ? `\nfile paths: ${notes.join(" ")}` : "";
  return { text: `${summary(ask)}${actions ? `\nactions: ${actions}` : ""}${paths}`, ask: { workspaceId: ask.workspaceId, id: ask.id } };
}
