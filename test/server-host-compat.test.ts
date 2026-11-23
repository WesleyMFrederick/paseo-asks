import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hostServer from "@getpaseo/plugin/server";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import contribute from "../index.server";
import { latestTurn } from "../server/host-sdk";
import { NUDGE } from "../server/nudge";

// The host substitutes its own SDK module, regardless of the plugin's npm SDK. Match the installed
// 0.17.2 archive's complete server export list, then assert parity with the recorded contract below.
vi.mock("@getpaseo/plugin/server", async (importOriginal) => {
  const sdk = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    ["spawnProcess", "execCommand", "terminateProcess", "defineAgentTool"].map((name) => [name, sdk[name]]),
  );
});
vi.mock("../server/listener", () => ({ listen: vi.fn(async () => ({ close: vi.fn() })) }));
vi.mock("../server/github", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  findGh: () => null,
}));

interface RuntimeContract {
  version: string;
  modules: Record<string, readonly string[]>;
  hooks: readonly string[];
  legacyEvents: Record<string, string>;
  legacyRequests: Record<string, string>;
  apiKeys: readonly string[];
  internalAgentCreation: boolean;
}
const CONTRACT: RuntimeContract = JSON.parse(readFileSync(new URL("./fixtures/paseo-0.17.2.json", import.meta.url), "utf8"));
const ROOT = new URL("../", import.meta.url);
const user = (text: string): AgentTimelineItem => ({ type: "user_message", text }) as AgentTimelineItem;
const reply = (text: string): AgentTimelineItem => ({ type: "assistant_message", text }) as AgentTimelineItem;
type HookHandler = (event: unknown, context: unknown) => unknown;
interface TestHost {
  readonly context: PluginServerContext;
  readonly handlers: ReadonlyMap<string, HookHandler>;
  readonly addHook: (name: string, handler: HookHandler) => void;
}

function createHost(): TestHost {
  const handlers = new Map<string, HookHandler>();
  const register = (name: string, handler: HookHandler) => {
    if (!CONTRACT.hooks.includes(name)) throw new Error(`Unknown lifecycle hook: ${name}`);
    handlers.set(name, handler);
  };
  const addHook = vi.fn(register);
  const context = {
    registerSettings: vi.fn(() => ({ read: async () => ({ status: "ready", values: { actOnReviewChanges: true } }) })),
    before: (name: string, handler: HookHandler) => register(CONTRACT.legacyRequests[name] ?? name, handler),
    on: (name: string, handler: HookHandler) => register(CONTRACT.legacyEvents[name] ?? name, handler),
    addHook,
    handle: vi.fn(),
  } as unknown as PluginServerContext;
  return { context, handlers, addHook };
}

async function withHost(run: (host: TestHost, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "asks-host-compat-"));
  const host = createHost();
  vi.stubEnv("PASEO_ASKS_DIR", dir);
  const dispose = contribute(host.context);
  try {
    await run(host, dir);
  } finally {
    await dispose();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
}

function page(items: readonly AgentTimelineItem[], cursor: number | null = null) {
  return {
    epoch: "epoch",
    entries: items.map((item, seqStart) => ({ item, seqStart, seqEnd: seqStart })),
    hasOlder: cursor !== null,
    startCursor: cursor === null ? null : { epoch: "epoch", seq: cursor },
  };
}

function sources(dir: string): string[] {
  return readdirSync(new URL(dir, ROOT), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("installed Paseo 0.17.2 host contract", () => {
  it("loads the real server entry with only the installed runtime's server exports", async () => {
    expect(CONTRACT.version).toBe("0.17.2");
    expect(Object.keys(hostServer).sort()).toEqual([...CONTRACT.modules["@getpaseo/plugin/server"]].sort());
    expect("latestTurn" in hostServer).toBe(false);
    expect(CONTRACT.apiKeys).not.toContain("notifications");
    await withHost(async (host) => {
      expect(host.handlers.has("agent.turn.after")).toBe(true);
      expect(host.handlers.has("agent.create.before")).toBe(true);
      expect(host.addHook).toHaveBeenCalledWith("schedule.run.finish.before", expect.any(Function));
      expect(host.handlers.has("schedule.run.finish.before")).toBe(false);
    });
  });

  it("rejects every unguarded named server/shared SDK import missing from that runtime", () => {
    const files = ["index.server.ts", ...sources("server"), ...sources("shared")];
    files.forEach((file) => {
      const source = ts.createSourceFile(file, readFileSync(new URL(file, ROOT), "utf8"), ts.ScriptTarget.Latest, true);
      source.statements.filter(ts.isImportDeclaration).forEach((statement) => {
        if (!ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith("@getpaseo/")) return;
        const clause = statement.importClause;
        if (!clause || clause.isTypeOnly) return;
        const specifier = statement.moduleSpecifier.text;
        const names = clause.namedBindings;
        if (!names || !ts.isNamedImports(names)) return;
        names.elements.filter((name) => !name.isTypeOnly).forEach((name) => {
          expect(CONTRACT.modules[specifier], `${file}: ${specifier}`).toContain((name.propertyName ?? name.name).text);
        });
      });
    });
  });

  it("records the whole latest reply when 0.17.2 supplies an empty compatibility timeline", async () => {
    const refetch = vi.fn()
      .mockResolvedValueOnce(page([reply("one?")], 30))
      .mockResolvedValueOnce(page([reply("Which ")], 10))
      .mockResolvedValueOnce(page([reply("Previous turn."), user("start"), reply("Pick: ")]));
    const api = { agents: { ref: () => ({ timeline: { refetch } }) } };
    await withHost(async (host, dir) => {
      await host.handlers.get("agent.turn.after")!({ agent: { id: "owner", workspaceId: "workspace" }, outcome: { kind: "failed" }, timeline: [] }, { paseo: api });
      expect(JSON.parse(readFileSync(join(dir, "last-output.json"), "utf8"))).toEqual({ owner: "Pick: Which one?" });
      expect(refetch.mock.calls.map(([options]) => options)).toEqual([
        { direction: "tail", limit: 200, projection: "projected" },
        { direction: "before", cursor: { epoch: "epoch", seq: 30 }, limit: 200, projection: "projected" },
        { direction: "before", cursor: { epoch: "epoch", seq: 10 }, limit: 200, projection: "projected" },
      ]);
    });
  });

  it("preserves the old nonempty hook timeline without refetching", async () => {
    const refetch = vi.fn();
    const api = { agents: { ref: () => ({ timeline: { refetch } }) } };
    await withHost(async (host, dir) => {
      await host.handlers.get("agent.turn.after")!({ agent: { id: "owner" }, outcome: { kind: "failed" }, timeline: [user("go"), reply("Old hook reply.")] }, { paseo: api });
      expect(JSON.parse(readFileSync(join(dir, "last-output.json"), "utf8"))).toEqual({ owner: "Old hook reply." });
      expect(refetch).not.toHaveBeenCalled();
    });
  });

  it("returns an empty turn at the start of empty history", async () => {
    const refetch = vi.fn().mockResolvedValue(page([]));
    expect(await latestTurn({ refetch })).toEqual([]);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the old nudge heuristic without attempting unsupported internal-agent creation", async () => {
    const send = vi.fn(async () => {});
    const create = vi.fn();
    const listModels = vi.fn();
    const agent = { id: "owner", workspaceId: "workspace", provider: "claude", model: "haiku", status: "idle" };
    const handle = { timeline: { refetch: vi.fn() }, refresh: async () => ({ agent }), current: () => agent, status: "idle", send };
    const api = {
      agents: { ref: () => handle, create },
      providers: { listModels },
      workspaces: { ref: () => ({ refresh: async () => ({ background: false }) }) },
    };
    expect(CONTRACT.internalAgentCreation).toBe(false);
    await withHost(async (host) => {
      await host.handlers.get("agent.turn.after")!({ agent, outcome: { kind: "completed" }, timeline: [user("go"), reply("Which one?")] }, { paseo: api });
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(NUDGE, expect.any(Object)));
      expect(create).not.toHaveBeenCalled();
      expect(listModels).not.toHaveBeenCalled();
    });
  });
});
