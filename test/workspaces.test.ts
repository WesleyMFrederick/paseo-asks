import { describe, expect, it } from "vitest";
import { activeWorkspaces, asksForSurfaces, isBackground } from "../server/workspaces";
import { firstExpanded, pillLabel, readerAsks } from "../shared/asks";

type Api = Parameters<typeof activeWorkspaces>[0];

describe("activeWorkspaces", () => {
  it("follows every page without including background workspaces", async () => {
    const pages: Record<string, { ids: string[]; next: string | null }> = {
      "": { ids: ["wks_1", "wks_2"], next: "c1" },
      c1: { ids: ["wks_3"], next: null },
    };
    const requests: unknown[] = [];
    const api = {
      workspaces: {
        list: async (options: { page: { cursor?: string } }) => {
          requests.push(options);
          const page = pages[options.page.cursor ?? ""];
          return {
            entries: page.ids.map((id) => ({ id, name: `name of ${id}` })),
            pageInfo: { hasMore: page.next !== null, nextCursor: page.next },
          };
        },
      },
    } as unknown as Api;

    const live = await activeWorkspaces(api);

    expect([...live]).toEqual([
      ["wks_1", "name of wks_1"],
      ["wks_2", "name of wks_2"],
      ["wks_3", "name of wks_3"],
    ]);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).not.toHaveProperty("includeBackground", true);
      expect(request).not.toHaveProperty("filter.includeBackground", true);
    }
  });
});

describe("isBackground", () => {
  const apiWith = (refresh: () => Promise<unknown>) =>
    ({ workspaces: { ref: () => ({ refresh }) } }) as unknown as Parameters<typeof isBackground>[0];

  it("is true only for a background workspace", async () => {
    expect(await isBackground(apiWith(async () => ({ id: "wks_1", background: true })), "wks_1")).toBe(true);
    expect(await isBackground(apiWith(async () => ({ id: "wks_1", background: false })), "wks_1")).toBe(false);
    expect(await isBackground(apiWith(async () => ({ id: "wks_1" })), "wks_1")).toBe(false);
    expect(await isBackground(apiWith(async () => null), "wks_1")).toBe(false);
  });

  it("counts an unreadable workspace as visible", async () => {
    expect(
      await isBackground(
        apiWith(async () => {
          throw new Error("daemon gone");
        }),
        "wks_1",
      ),
    ).toBe(false);
  });
});

describe("archived relay sources", () => {
  it("keeps a relayed ask in the recipient's pill and expansion, but out of the global queue", () => {
    const at = "2026-11-23T00:00:00Z";
    const relay = {
      id: "A1", workspaceId: "archived", ownerAgentId: "owner", status: "open" as const,
      relayedTo: [{ agentId: "reader", at, batch: "latest", index: 0 }],
    };
    const active = { ...relay, id: "A2", workspaceId: "live", relayedTo: [] };
    const unrelayed = { ...relay, id: "A3", relayedTo: [] };
    const { asks, composerAsks } = asksForSurfaces([relay, active, unrelayed], new Map([["live", "Live"]]));

    expect(asks).toEqual([active]);
    expect(readerAsks(composerAsks, "reader")).toEqual([relay]);
    expect(pillLabel(composerAsks, "reader")).toBe("Asks · 1");
    expect(firstExpanded(composerAsks, "reader")).toEqual(["archived/A1"]);
    expect(readerAsks(composerAsks, "unrelated")).toEqual([]);
  });
});
