import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { Ask } from "../shared/asks";

import { NUDGE } from "../shared/prompts";

export { NUDGE, REFRESH } from "../shared/prompts";

const ASK_TOOL = /(^|[_.])ask_(create|update|resolve|list)$/;
const ASK_ID = /\bA\d+\b/g;
const DECISION_ID = /decision-[A-Za-z0-9_-]+/g;
const MIN_TITLE = 12;

/** A re-shown decision is already recorded when a scoped open ask names its card or title. */
function recordsReply(ask: Ask, text: string): boolean {
  if (!["open", "in_progress"].includes(ask.status)) return false;
  const haystack = `${ask.title}\n${ask.body ?? ""}`;
  if ((text.match(DECISION_ID) ?? []).some((id) => haystack.includes(id))) return true;
  const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const title = squash(ask.title);
  return title.length >= MIN_TITLE && squash(text).includes(title);
}

/** Whether an ask id names an open ask in the agent's own workspace. Ids are numbered per workspace. */
export type IsOpenAsk = (id: string) => boolean;

/**
 * The final reply of a finished turn that never touched asks, or null when there is nothing to check.
 * Turns that answer the nudge itself are never checked. A reply that points to one of its workspace's open asks
 * is recorded; ids of asks elsewhere (an explainer naming the ask it explains) don't count.
 */
export function unrecordedReply(timeline: readonly AgentTimelineItem[], isOpenAsk: IsOpenAsk): string | null {
  const reply: string[] = [];
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index]!;
    if (item.type === "user_message") {
      if (item.text.includes(NUDGE)) return null;
      break;
    }
    if (item.type === "tool_call" && ASK_TOOL.test(item.name)) return null;
    if (item.type === "assistant_message") reply.unshift(item.text);
  }
  const text = reply.join("").trim();
  if (!text) return null;
  return (text.match(ASK_ID) ?? []).some(isOpenAsk) ? null : text;
}

/** Whether a finished turn ends on an unrecorded question, without starting a host-specific helper agent. */
export async function shouldNudge(
  timeline: readonly AgentTimelineItem[],
  isOpenAsk: IsOpenAsk,
  openAsks: readonly Ask[] = [],
): Promise<boolean> {
  const reply = unrecordedReply(timeline, isOpenAsk);
  if (!reply || openAsks.some((ask) => recordsReply(ask, reply))) return false;
  return endsWithQuestion(reply);
}

/** The last paragraph has a question mark outside code and links. */
export function endsWithQuestion(text: string): boolean {
  const prose = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
  const last = prose.split(/\n\s*\n/).pop() ?? "";
  return last.includes("?");
}

