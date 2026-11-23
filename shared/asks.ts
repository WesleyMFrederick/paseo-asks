import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ASK_KINDS = ["decision", "review", "pr", "followup", "action", "question"] as const;
export const ASK_STATUSES = ["open", "in_progress", "done", "dropped"] as const;
export const ACTION_KINDS = ["send", "resolve", "open"] as const;

export const ActionSchema = z.object({
  id: z.string(),
  label: z.string().min(1).max(60),
  kind: z.enum(ACTION_KINDS),
  prompt: z.string().optional(),
  url: z.string().url().optional(),
  recommended: z.boolean().optional(),
});
export type Action = z.infer<typeof ActionSchema>;

export const LinkSchema = z.object({ label: z.string(), url: z.string().url() });

export const OutcomeSchema = z.object({
  actionId: z.string().optional(),
  label: z.string().optional(),
  note: z.string().optional(),
  by: z.enum(["human", "agent"]),
  at: z.string(),
});

/** A preview deployment of the PR's head commit, one per URL. `link` is where tapping it goes. */
export const DeploymentSchema = z.object({
  label: z.string(),
  state: z.enum(["ready", "deploying", "failed"]),
  url: z.string().optional(),
  link: z.string().optional(),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

export const PrStateSchema = z.object({
  number: z.number(),
  url: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  isDraft: z.boolean(),
  reviewDecision: z.string().nullable(),
  checks: z.enum(["passing", "failing", "pending", "none"]),
  mergeable: z.string(),
  /** Unset when the deployments lookup failed or predates this field; empty when the head commit has none. */
  deployments: z.array(DeploymentSchema).optional(),
  fetchedAt: z.string(),
});
export type PrState = z.infer<typeof PrStateSchema>;

const RelayStampSchema = z.object({
  agentId: z.string(),
  at: z.string(),
  batch: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
});
type RelayStamp = z.infer<typeof RelayStampSchema>;

export const AskSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  ownerAgentId: z.string(),
  kind: z.enum(ASK_KINDS),
  title: z.string(),
  body: z.string().optional(),
  actions: z.array(ActionSchema),
  links: z.array(LinkSchema),
  status: z.enum(ASK_STATUSES),
  outcome: OutcomeSchema.optional(),
  /** The owning agent is gone; nobody will hear about a resolution. */
  orphaned: z.boolean().optional(),
  /** The plugin set in_progress while the owner runs; human sends and explicit in_progress clear it. */
  autoStatus: z.boolean().optional(),
  /** Tell the owner when the linked PR changes (merged, closed, checks, review). */
  subscribe: z.boolean().optional(),
  /** Raised by the plugin for requested changes the human holds back; its PR is not polled for it. */
  heldReview: z.boolean().optional(),
  /** Live state of the first GitHub PR in links, refreshed by the plugin. */
  pr: PrStateSchema.optional(),
  /** When the owner was last reminded that this ask sat in progress at the end of its turn. */
  remindedAt: z.string().optional(),
  /** The agent the human talks this ask through with; it may resolve or update the ask from its own workspace. */
  discussionAgentId: z.string().optional(),
  /** Agents whose chat pointed at this ask; one latest entry per reader, with a shared identity for each relay request. */
  relayedTo: z.array(RelayStampSchema).optional(),
  /** The explainer's own workspace. Unset for a side chat in the ask's workspace (the fallback, and asks from before). */
  discussionWorkspaceId: z.string().optional(),
  /** callKey() of the latest agent call on this ask; its chat card stays live, older ones show their own snapshot. */
  lastCall: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Ask = z.infer<typeof AskSchema>;

export const OPEN_STATUSES: readonly Ask["status"][] = ["open", "in_progress"];

/** Closed cards are read-only: no reply field or answer buttons. */
export function canAnswer(ask: Pick<Ask, "status">): boolean {
  return OPEN_STATUSES.includes(ask.status);
}

/** Actions available in an expanded ask card. */
export function visibleActions(ask: Pick<Ask, "status" | "autoStatus" | "actions">): Action[] {
  if (!canAnswer(ask)) return ask.actions.filter((action) => action.kind === "open");
  return ask.actions.filter((action) => ask.status === "open" || (ask.status === "in_progress" && ask.autoStatus === true) || action.kind !== "send");
}

/** The asks an agent's composer pill counts and its popover lists: the ones it owns plus the ones relayed to it. */
export function readerAsks<T extends Pick<Ask, "ownerAgentId" | "relayedTo">>(asks: readonly T[], agentId: string): T[] {
  return asks.filter((ask) => ask.ownerAgentId === agentId || ask.relayedTo?.some((entry) => entry.agentId === agentId));
}

/** The composer pill's face: the same asks its popover lists (this agent's own and relayed open and in-progress ones). */
export function pillLabel(asks: readonly Pick<Ask, "ownerAgentId" | "status" | "relayedTo">[], agentId: string): string {
  const mine = readerAsks(asks, agentId);
  const open = mine.filter((ask) => ask.status === "open").length;
  const working = mine.filter((ask) => ask.status === "in_progress").length;
  const parts = [open > 0 ? `${open}` : "", working > 0 ? `${working} in progress` : ""].filter(Boolean);
  return parts.length ? `Asks · ${parts.join(" · ")}` : "No asks";
}

/** Latest relay per reader, including closed asks so completing a batch never reopens an older one. */
export function latestRelays(asks: readonly Pick<Ask, "relayedTo">[]): Record<string, RelayStamp> {
  return asks.flatMap((ask) => ask.relayedTo ?? []).reduce<Record<string, RelayStamp>>((latest, entry) => {
    if (!latest[entry.agentId] || entry.at > latest[entry.agentId]!.at) latest[entry.agentId] = entry;
    return latest;
  }, {});
}

/**
 * Keys (`workspaceId/id`) of the popover rows that start expanded: the still-open (open or in-progress) asks of the
 * newest relay to this agent, newest first, which is the order the reply pointed at them. Empty when none.
 */
export function firstExpanded(asks: readonly Pick<Ask, "workspaceId" | "id" | "status" | "orphaned" | "relayedTo">[], agentId: string, latest?: RelayStamp): string[] {
  const relayed = asks.flatMap((ask) => {
    const entry = ask.relayedTo?.find((entry) => entry.agentId === agentId);
    const key = `${ask.workspaceId}/${ask.id}`;
    return entry ? [{ key, at: Date.parse(entry.at), batch: entry.batch, index: entry.index, eligible: !ask.orphaned && OPEN_STATUSES.includes(ask.status) }] : [];
  }).sort((a, b) => b.at - a.at || (a.index ?? 0) - (b.index ?? 0));
  const newest = latest ? (latest.batch !== undefined ? latest : relayed.find((entry) => entry.at === Date.parse(latest.at))) : relayed[0];
  return relayed
    .filter((entry) => entry.eligible && (newest?.batch !== undefined ? entry.batch === newest.batch : entry === newest))
    .map((entry) => entry.key);
}

/** The harness relays the asks a reply's pointer lines name, in pointer order, to the agent whose chat holds the reply. */
export const RelayInputSchema = z.object({
  readerAgentId: z.string().min(1),
  asks: z.array(z.object({ workspaceId: z.string(), id: z.string() })).min(1),
});

/** Move an open ask whose owner is closed to a live agent; `by` is the caller's agent id, recorded in the log. */
export const ReassignInputSchema = z.object({ workspaceId: z.string().min(1), id: z.string().min(1), toAgentId: z.string().min(1), reason: z.string().trim().min(1), by: z.string().trim().min(1) });

/** Close (mark done) an open ask whose owner is closed; `by` is the caller's agent id, recorded in the log. */
export const CloseInputSchema = z.object({ workspaceId: z.string().min(1), id: z.string().min(1), reason: z.string().trim().min(1), by: z.string().trim().min(1) });

/** The workspaces an ask shows in: its own, and the one it is being explained in, so the human answers it there. */
export function workspacesOf(ask: Pick<Ask, "workspaceId" | "discussionWorkspaceId">): string[] {
  return ask.discussionWorkspaceId && ask.discussionWorkspaceId !== ask.workspaceId
    ? [ask.workspaceId, ask.discussionWorkspaceId]
    : [ask.workspaceId];
}

export function showsIn(ask: Pick<Ask, "workspaceId" | "discussionWorkspaceId">, workspaceId: string): boolean {
  return workspacesOf(ask).includes(workspaceId);
}

/** Waits on the human: open. A linked PR's state says nothing about it; the owner closes the ask when its work is done. */
export function awaitsYou(ask: Pick<Ask, "status">): boolean {
  return ask.status === "open";
}

/** The sidebar counter: asks waiting on you, leaving out workspaces you snoozed. */
export function waitingCount(
  asks: readonly Pick<Ask, "status" | "workspaceId">[],
  snoozed: ReadonlySet<string>,
): number {
  return asks.filter((ask) => awaitsYou(ask) && !snoozed.has(ask.workspaceId)).length;
}

/** Per workspace: how many asks wait on you and the newest one's id, which changes when a new ask arrives. */
export function waitingByWorkspace(
  asks: readonly Pick<Ask, "id" | "status" | "workspaceId" | "discussionWorkspaceId" | "createdAt">[],
): Map<string, { count: number; newestId: string }> {
  const result = new Map<string, { count: number; newestId: string; newestAt: string }>();
  for (const ask of asks) {
    if (!awaitsYou(ask)) continue;
    for (const workspaceId of workspacesOf(ask)) {
      const entry = result.get(workspaceId);
      if (!entry) result.set(workspaceId, { count: 1, newestId: ask.id, newestAt: ask.createdAt });
      else {
        entry.count++;
        if (ask.createdAt > entry.newestAt) Object.assign(entry, { newestId: ask.id, newestAt: ask.createdAt });
      }
    }
  }
  return new Map([...result].map(([id, { count, newestId }]) => [id, { count, newestId }]));
}

/** Asks wait in a queue: the one waiting longest comes first, and updates don't move an ask. */
export function oldestFirst(a: Pick<Ask, "createdAt">, b: Pick<Ask, "createdAt">): number {
  return a.createdAt.localeCompare(b.createdAt);
}

/** One waiting ask as the host's Overview lists it. */
export interface AskEntry {
  id: string;
  title: string;
  detail?: string;
}

/** A workspace's asks as the host summary shows them: what waits on you, oldest first, as the Asks panel orders them. */
export interface WorkspaceAsks {
  count: number;
  newestId?: string;
  entries: AskEntry[];
}

const KIND_LABELS: Record<Ask["kind"], string> = {
  decision: "Decision",
  review: "Review",
  pr: "PR",
  followup: "Follow-up",
  action: "Action",
  question: "Question",
};

/** A short facts line for an ask, e.g. "Decision · 2 options" or "PR #30". */
export function askDetail(ask: Pick<Ask, "kind" | "actions" | "pr" | "orphaned">): string {
  const options = ask.actions.filter((action) => action.kind === "resolve").length;
  const parts = [
    ask.kind === "pr" && ask.pr ? `PR #${ask.pr.number}` : KIND_LABELS[ask.kind],
    ask.kind === "decision" && options > 0 ? `${options} option${options === 1 ? "" : "s"}` : "",
    ask.orphaned ? "agent archived" : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

/**
 * Every workspace with any ask (any status), so one with nothing waiting reports 0 instead of nothing.
 * Like `waitingCount`, asks in snoozed workspaces don't wait on you.
 */
export function workspaceAsks(
  asks: readonly Pick<Ask, "id" | "title" | "kind" | "actions" | "pr" | "orphaned" | "status" | "workspaceId" | "discussionWorkspaceId" | "createdAt">[],
  snoozed: ReadonlySet<string>,
): Map<string, WorkspaceAsks> {
  const result = new Map<string, WorkspaceAsks>();
  for (const ask of [...asks].sort(oldestFirst)) {
    for (const workspaceId of workspacesOf(ask)) {
      let workspace = result.get(workspaceId);
      if (!workspace) result.set(workspaceId, (workspace = { count: 0, entries: [] }));
      // Snoozing the ask's own workspace quiets it in the explainer's too, as the sidebar count does.
      if (!awaitsYou(ask) || snoozed.has(workspaceId) || snoozed.has(ask.workspaceId)) continue;
      workspace.count++;
      workspace.newestId = ask.id;
      workspace.entries.push({ id: ask.id, title: ask.title, detail: askDetail(ask) });
    }
  }
  return result;
}

export const listAsks = defineRpc({
  name: "asks.list",
  input: z.object({ workspaceId: z.string().optional(), includeClosed: z.boolean().optional() }),
  output: z.object({
    asks: z.array(AskSchema),
    /** Active asks plus inactive asks relayed to an agent, for composer pills and their panels only. */
    composerAsks: z.array(AskSchema).optional(),
    latestRelays: z.record(z.string(), RelayStampSchema).optional(),
    /** Workspace id → display name, filled when listing every workspace. */
    workspaceNames: z.record(z.string(), z.string()).optional(),
  }),
});

/** A human disposes of an ask: run one of its actions, mark it done, or drop it. */
export const actOnAsk = defineRpc({
  name: "asks.act",
  input: z.object({
    workspaceId: z.string(),
    id: z.string(),
    verb: z.enum(["action", "done", "drop", "reply"]),
    actionId: z.string().optional(),
    note: z.string().optional(),
  }),
  /** How the owning agent hears of it: now, when its current turn ends, or never (orphaned). */
  output: z.object({ ask: AskSchema, delivery: z.enum(["sent", "queued", "nobody"]) }),
});

/**
 * Open (or reopen) the discussion of one ask: an explainer in a workspace of its own, or a read-only side chat in the
 * ask's workspace when that can't be created. `note` is the human's first message to it.
 */
export const discussAsk = defineRpc({
  name: "asks.discuss",
  input: z.object({ workspaceId: z.string(), id: z.string(), note: z.string().optional() }),
  output: z.object({ agentId: z.string(), workspaceId: z.string().optional(), created: z.boolean() }),
});

export const TimelinePositionSchema = z.object({ epoch: z.string(), seq: z.number().int().nonnegative() });
export type TimelinePosition = z.infer<typeof TimelinePositionSchema>;

/** Where an ask was raised in its owner's chat, so "Show in chat" scrolls there. No position: open the chat at its end. */
export const locateAsk = defineRpc({
  name: "asks.locate",
  input: z.object({ workspaceId: z.string(), id: z.string() }),
  output: z.object({ agentId: z.string(), position: TimelinePositionSchema.optional() }),
});

/** The title of the workspace an ask is explained in; the card names it, so both read the same. */
export function discussionTitle(ask: Pick<Ask, "id" | "title">): string {
  const head = `Explain ${ask.id}: `;
  const max = 60;
  return ask.title.length + head.length <= max ? head + ask.title : `${head}${ask.title.slice(0, max - head.length - 1).trimEnd()}…`;
}

/** Ask an agent to bring its asks up to date. Sent now if idle, otherwise when its turn ends. */
export const refreshAsks = defineRpc({
  name: "asks.refresh",
  input: z.object({ agentId: z.string() }),
  output: z.object({ sent: z.boolean() }),
});

const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

/** A GitHub PR's URL without trailing parts (`/files`, `#discussion…`), or undefined for any other link. */
export function prLinkOf(url: string): string | undefined {
  return url.match(PR_URL)?.[0];
}

/** The PR to preview in Paseo when this link is opened: only a bare PR URL. A comment, file or commit link opens on GitHub, since the preview can't show it. */
export function prPreviewOf(url: string): string | undefined {
  const pr = prLinkOf(url);
  return pr && /^\/?$/.test(url.slice(pr.length)) ? pr : undefined;
}

export function prUrlOf(ask: Pick<Ask, "links">): string | undefined {
  return ask.links.map((link) => prLinkOf(link.url)).find(Boolean);
}
