import * as hostServer from "@getpaseo/plugin/server";
import type { PaseoAgentTimelineHandle } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginHookAgent } from "@getpaseo/plugin/server";

type TimelineSource = Pick<PaseoAgentTimelineHandle, "refetch">;
type ReadLatestTurn = (timeline: TimelineSource) => Promise<readonly AgentTimelineItem[]>;
interface TimelinePage {
  readonly entries: readonly { readonly item: AgentTimelineItem }[];
  readonly hasOlder: boolean;
  readonly startCursor: { readonly epoch: string; readonly seq: number } | null;
}

// Hosts, not the installed npm SDK, supply these exports. Stock Paseo 0.17.2 has no latestTurn.
const HOST_LATEST_TURN = "latestTurn" in hostServer && typeof hostServer.latestTurn === "function"
  ? hostServer.latestTurn as ReadLatestTurn
  : null;
const PAGE_SIZE = 200;

async function collectTurn(
  timeline: TimelineSource,
  page: TimelinePage,
  newer: readonly (readonly AgentTimelineItem[])[] = [],
): Promise<readonly AgentTimelineItem[]> {
  const items = page.entries.map((entry) => entry.item);
  const lastUser = items.reduce((found, item, index) => item.type === "user_message" ? index : found, -1);
  if (lastUser >= 0) return [items.slice(lastUser), ...newer].flat();
  const chunks = [items, ...newer];
  if (!page.hasOlder || !page.startCursor) return chunks.flat();
  const older = await timeline.refetch({
    direction: "before", cursor: page.startCursor, limit: PAGE_SIZE, projection: "projected",
  });
  return collectTurn(timeline, older, chunks);
}

/**
 * Contract: preserve the old hook's turn history when supplied; fetch it when stock 0.17.2 sends an empty
 * compatibility timeline. Page until the latest user message so streamed replies are not truncated.
 */
export async function latestTurn(
  timeline: TimelineSource,
  legacyTimeline: readonly AgentTimelineItem[] = [],
): Promise<readonly AgentTimelineItem[]> {
  if (HOST_LATEST_TURN) return HOST_LATEST_TURN(timeline);
  if (legacyTimeline.length) return legacyTimeline;
  return collectTurn(timeline, await timeline.refetch({ direction: "tail", limit: PAGE_SIZE, projection: "projected" }));
}

// COMPAT(scheduleRunAttention): FSH hosts from fullstackhouse/paseo#106 run this hook and advertise
// `features.scheduleRunAttention`; older hosts reject the name at registration. Not in the npm SDK.
declare module "@getpaseo/plugin/internal/lifecycle" {
  interface PluginScheduleRunFinishRequest {
    readonly schedule: { readonly id: string; readonly name: string | null };
    readonly runId: string;
    readonly agent: PluginHookAgent;
    attention: { reason: "failed" | "permission" | "plugin"; message: string | null } | null;
  }
  interface PluginHookRequests {
    "schedule.run.finish.before": PluginScheduleRunFinishRequest;
  }
}

// COMPAT(pluginNotifications): FSH hosts may supply this; stock Paseo 0.17.2 does not.
declare module "@getpaseo/client" {
  interface PaseoApi {
    readonly notifications?: {
      send(input: {
        title: string;
        body: string;
        open?: { screen: string; params?: Record<string, string> } | { agentId: string };
        key?: string;
      }): Promise<{ delivered: boolean; dropped?: string }>;
    };
  }
}
