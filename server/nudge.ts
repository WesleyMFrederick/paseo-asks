import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { Ask } from "../shared/asks";

/** Sent once when a turn ends on a question to the human that no ask records. */
export const NUDGE =
  '[asks] Your last reply asks the human something, but no ask records it, so it is easy to miss. If you are waiting on them, call ask_create now (one per item) and reply with just the id. If you are not, reply "no ask" and nothing else.';

/** Sent when the human presses Refresh on an agent's asks. */
export const REFRESH =
  "[asks] The human wants your asks up to date. Run ask_list with scope mine. Create an ask for anything you are waiting on them for that has none, and ask_update or ask_resolve the ones that are out of date. Then reply in one line.";

const ASK_TOOL = /(^|[_.])ask_(create|update|resolve|list)$/;
const ASK_ID = /\bA\d+\b/;
const DECISION_ID = /decision-[A-Za-z0-9_-]+/g;
const MIN_TITLE = 12;

/**
 * Whether a finished turn ended with a question to the human and never touched asks.
 * Turns that answer the nudge itself, and replies an open ask already records, are never nudged.
 */
export function shouldNudge(timeline: readonly AgentTimelineItem[], openAsks: readonly Ask[] = []): boolean {
  const reply: string[] = [];
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index]!;
    if (item.type === "user_message") {
      if (item.text.includes(NUDGE)) return false;
      break;
    }
    if (item.type === "tool_call" && ASK_TOOL.test(item.name)) return false;
    if (item.type === "assistant_message") reply.unshift(item.text);
  }
  const text = reply.join("");
  if (ASK_ID.test(text) || !endsWithQuestion(text)) return false;
  return !openAsks.some((ask) => recordsReply(ask, text));
}

/** An open ask records a re-shown card: its body names a decision id in the reply, or its title is quoted in the reply. */
function recordsReply(ask: Ask, text: string): boolean {
  if (!["open", "in_progress"].includes(ask.status)) return false;
  const haystack = `${ask.title}\n${ask.body ?? ""}`;
  if ((text.match(DECISION_ID) ?? []).some((id) => haystack.includes(id))) return true;
  const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const title = squash(ask.title);
  return title.length >= MIN_TITLE && squash(text).includes(title);
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
