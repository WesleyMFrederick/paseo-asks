import type { PaseoApi } from "@getpaseo/client";
import type { Ask } from "../shared/asks";

/** The global queue hides archived sources; a relay remains available in its recipient's composer. */
export function asksForSurfaces<T extends Pick<Ask, "workspaceId" | "relayedTo">>(
  asks: readonly T[],
  live: ReadonlyMap<string, string>,
): { asks: T[]; composerAsks: T[] } {
  return {
    asks: asks.filter((ask) => live.has(ask.workspaceId)),
    composerAsks: asks.filter((ask) => live.has(ask.workspaceId) || !!ask.relayedTo?.length),
  };
}

const PAGE = 200;

/** Workspace id → name for visible workspaces; background and archived ones are absent. */
export async function activeWorkspaces(
  api: Pick<PaseoApi, "workspaces">,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const { entries, pageInfo } = await api.workspaces.list({
      page: { limit: PAGE, cursor },
    });
    for (const workspace of entries) names.set(workspace.id, workspace.name);
    cursor = pageInfo.hasMore ? (pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return names;
}

/**
 * Whether a workspace is background (hidden from the sidebar, e.g. an Inbox review run). Nobody reads asks there,
 * and a nudge would start a turn that a plugin like paseo-inbox takes for the human stepping in.
 * Unknown or unreadable workspaces count as visible.
 */
export async function isBackground(api: Pick<PaseoApi, "workspaces">, workspaceId: string): Promise<boolean> {
  try {
    const workspace = await api.workspaces.ref(workspaceId).refresh();
    return workspace?.background === true;
  } catch (error) {
    console.error(`[asks] could not read workspace ${workspaceId}`, error);
    return false;
  }
}
