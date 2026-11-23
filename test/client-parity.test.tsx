import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createElement, type ReactElement, type ReactNode } from "react";
import type * as ReactModule from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import contribute from "../index.client";
import { AskCard, AsksView } from "../client/AsksView";
import { asksChanged } from "../client/changes";
import { Markdown } from "../client/markdown";
import { actOnAsk, discussAsk, refreshAsks, type Ask } from "../shared/asks";

const host = vi.hoisted(() => ({
  asks: [] as Ask[],
  rpc: vi.fn(),
  toast: { show: vi.fn(), error: vi.fn() },
  invalidateQueries: vi.fn(),
  states: new Map<string, unknown[]>(),
  frame: { values: [] as unknown[], index: 0 },
}));

// No DOM/React Native renderer is installed. Evaluate the real component tree with persistent
// hook slots; only host primitives, polling and mutation delivery are replaced. Tests press the
// resulting controls, then render again, rather than inspecting source or exporting internals.
vi.mock("react", async (original) => {
  const react = await original<typeof ReactModule>();
  return {
    ...react,
    useState(initial: unknown) {
      const values = host.frame.values;
      const index = host.frame.index++;
      if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
      return [values[index], (next: unknown) => {
        values[index] = typeof next === "function" ? next(values[index]) : next;
      }];
    },
    useMemo: (compute: () => unknown) => compute(),
    useCallback: (callback: unknown) => callback,
    useContext: () => undefined,
    useEffect: () => {},
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  };
});
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", Platform: { OS: "web" },
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (rpc: unknown) => (input: unknown) => host.rpc(rpc, input),
  useAgent: () => "w1",
  useSettings: () => ({ status: "ready", values: { foldChatBodies: false } }),
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  Icon: "Icon", ScrollView: "ScrollView", TextInput: "TextInput", useToast: () => host.toast,
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({ Markdown: "Markdown", SidebarRow: "SidebarRow", Menu: undefined }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    isPending: false, isError: false,
    data: { asks: host.asks, workspaceNames: { w1: "First workspace", w2: "Second workspace" } },
  }),
  useQueryClient: () => ({ invalidateQueries: host.invalidateQueries }),
  useMutation: (options: {
    mutationFn: (input: unknown) => Promise<unknown>;
    onSuccess?: (result: unknown, input: unknown) => void;
  }) => ({
    isPending: false,
    mutate: async (input: unknown) => options.onSuccess?.(await options.mutationFn(input), input),
  }),
}));

interface HostProps extends Record<string, unknown> {
  children?: ReactNode;
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress(): void | Promise<void>;
  style?: unknown;
}
type Node = { type: string; props: HostProps; children: (Node | string)[] };

function render(root: ReactNode) {
  const visited = new Set<string>();
  function walk(value: ReactNode, path: string): (Node | string)[] {
    if (value == null || typeof value === "boolean") return [];
    if (typeof value === "string" || typeof value === "number") return [String(value)];
    if (Array.isArray(value)) return value.flatMap((child, index) => walk(child, `${path}/${index}`));
    const element = value as ReactElement<HostProps>;
    const here = `${path}/${element.key ?? ""}`;
    if (typeof element.type === "function") {
      visited.add(here);
      const values = host.states.get(here) ?? [];
      host.states.set(here, values);
      host.frame = { values, index: 0 };
      return walk((element.type as (props: HostProps) => ReactNode)(element.props), `${here}/render`);
    }
    // Fragments and the OpenPr context provider just pass their children through in this harness.
    if (typeof element.type !== "string") return walk(element.props.children, `${here}/children`);
    return [{ type: element.type, props: element.props, children: walk(element.props.children, `${here}/children`) }];
  }
  const tree = walk(root, "root");
  for (const key of host.states.keys()) if (!visited.has(key)) host.states.delete(key);
  const nodes: Node[] = [];
  const text: string[] = [];
  function collect(items: (Node | string)[]) {
    for (const item of items) {
      if (typeof item === "string") text.push(item);
      else { nodes.push(item); collect(item.children); }
    }
  }
  collect(tree);
  return {
    nodes,
    text: text.join(""),
    button(label: string) {
      const matches = nodes.filter((node) => node.type === "Pressable" && node.props.accessibilityLabel === label);
      expect(matches, `button ${label}`).toHaveLength(1);
      expect(matches[0].props.disabled).not.toBe(true);
      return matches[0];
    },
    hasButton: (label: string) => nodes.some((node) => node.type === "Pressable" && node.props.accessibilityLabel === label),
  };
}

const theme = { colors: {
  surface0: "#000", surface1: "#111", surface2: "#222", foreground: "#fff",
  foregroundMuted: "#aaa", border: "#333", accent: "#08f", accentForeground: "#fff",
  statusWarning: "#f80", statusDanger: "#f00", statusSuccess: "#0f0",
} } as PluginTheme;

function ask(overrides: Partial<Ask> = {}): Ask {
  return {
    id: "A1", workspaceId: "w1", ownerAgentId: "owner", kind: "decision", title: "First ask",
    body: "First details", status: "open", actions: [], links: [],
    createdAt: "2026-11-23T00:00:00Z", updatedAt: "2026-11-23T00:00:00Z", ...overrides,
  };
}

beforeEach(() => {
  host.states.clear();
  host.asks = [];
  vi.clearAllMocks();
  host.rpc.mockImplementation(async (rpc, input) => {
    if (rpc === refreshAsks) return { sent: true };
    if (rpc === discussAsk) return { agentId: "explainer" };
    if (rpc === actOnAsk) {
      host.asks = host.asks.map((item) => item.id === input.id && item.workspaceId === input.workspaceId
        ? { ...item, status: "in_progress", autoStatus: undefined } : item);
      return { delivery: "sent" };
    }
    return { asks: host.asks };
  });
});

describe("restored client contracts", () => {
  it("Given an agent with no asks, When its composer pill opens, Then Refresh asks remains reachable after count updates", async () => {
    // Given
    let agentObserver!: { snapshot(input: { entries: { agent: { id: string; workspaceId: string } }[] }): void };
    let pill!: Parameters<PluginClientContext["addComposerPill"]>[0];
    const update = vi.fn((patch: Partial<typeof pill.button>) => Object.assign(pill.button, patch));
    const subscription = { subscribe: vi.fn(() => () => {}), release: async () => {} };
    // This host implements the contributions exercised here, not unrelated SDK capabilities.
    const client = {
      addWorkspacePanel: vi.fn(), addScreen: vi.fn(), addSettingsScreen: vi.fn(),
      addSidebarHeaderItem: vi.fn(), addCommandCenterItem: vi.fn(),
      addTimelineTransformer: vi.fn(), addTimelineRenderer: vi.fn(), openScreen: vi.fn(), openPanel: vi.fn(),
      addComposerPill: vi.fn((input: typeof pill) => { pill = input; return { update, remove: vi.fn() }; }),
      rpc: vi.fn(async () => ({ asks: [] })),
      paseo: {
        agents: { list: async () => ({ subscription: { subscribe: (observer: typeof agentObserver) => { agentObserver = observer; } } }) },
        workspaces: { list: async () => ({ subscription }) },
      },
    } as unknown as PluginClientContext;
    const stop = contribute(client);
    try {
      await Promise.resolve();
      // When
      agentObserver.snapshot({ entries: [{ agent: { id: "owner", workspaceId: "w1" } }] });
      expect(pill.button.visible).not.toBe(false);
      await Promise.resolve();
      asksChanged();
      await Promise.resolve();
      // Then: capture the actual contribution, not a private pill helper.
      expect(update).toHaveBeenCalled();
      expect(pill.button.visible).not.toBe(false);
      if (pill.button.behavior?.kind !== "popover") throw new Error("Expected the asks popover");
      const page = render(createElement(pill.button.behavior.Content, {
        theme, layout: { compact: false }, context: "agent", workspaceId: "w1", agentId: "owner", close: vi.fn(),
      }));
      expect(page.text).toContain("This agent has no open asks.");
      await page.button("Refresh asks").props.onPress();
      expect(host.rpc).toHaveBeenCalledWith(refreshAsks, { agentId: "owner" });
      expect(host.toast.show).toHaveBeenCalledWith("Asked the agent to update its asks.");
    } finally { stop(); }
  });

  it("Given an open ask, When a send action puts it in progress, Then Discuss still starts a discussion", async () => {
    // Given
    host.asks = [ask({ actions: [{ id: "start", label: "Start work", kind: "send" }] })];
    const openAgent = vi.fn();
    const root = <AsksView theme={theme} compact={false} workspaceId="w1" openAgent={openAgent} />;
    render(root).button("A1: First ask").props.onPress();
    // When
    await render(root).button("Start work").props.onPress();
    expect(host.rpc).toHaveBeenCalledWith(actOnAsk, expect.objectContaining({ verb: "action", actionId: "start" }));
    expect(host.asks[0].status).toBe("in_progress");
    // Then
    await render(root).button("Discuss").props.onPress();
    expect(host.rpc).toHaveBeenCalledWith(discussAsk, { workspaceId: "w1", id: "A1", note: "" });
    expect(openAgent).toHaveBeenCalledWith("explainer");
  });

  it.each(["in_progress", "done", "dropped"] as const)(
    "Given a non-orphaned %s chat card, When expanded, Then Discuss is available without restoring closed answer controls",
    async (status) => {
      // Given
      host.asks = [ask({ status, actions: [
        { id: "choose", label: "Choose", kind: "resolve" },
        { id: "open", label: "Read link", kind: "open", url: "https://example.com" },
      ] })];
      const root = <AskCard theme={theme} compact={false} agentId="owner" askId="A1" verb="create" call="call" snapshot={{}} changed={[]} />;
      // When
      render(root).button("A1: First ask").props.onPress();
      const page = render(root);
      // Then
      await page.button("Discuss").props.onPress();
      expect(host.rpc).toHaveBeenCalledWith(discussAsk, { workspaceId: "w1", id: "A1", note: "" });
      page.button("Read link ↗");
      expect(page.hasButton("Choose")).toBe(status === "in_progress");
      expect(page.hasButton("Mark done")).toBe(status === "in_progress");
      expect(page.hasButton("Drop ask")).toBe(status === "in_progress");
      expect(page.nodes.some((node) => node.type === "TextInput")).toBe(status === "in_progress");
    },
  );

  it("Given an orphaned displayed ask, When expanded, Then Discuss is absent", () => {
    // Given
    host.asks = [ask({ orphaned: true })];
    const root = <AsksView theme={theme} compact={false} workspaceId="w1" />;
    // When
    render(root).button("A1: First ask").props.onPress();
    // Then
    expect(render(root).hasButton("Discuss")).toBe(false);
  });

  it.each(["workspace", "global"] as const)(
    "Given two %s rows, When both open, Then both stay expanded and recommended actions retain their star and highlight",
    (surface) => {
      // Given: the global case deliberately repeats an ask id across workspaces.
      host.asks = [ask({ actions: [{ id: "yes", label: "Recommended choice", kind: "resolve", recommended: true }] }),
        ask({ id: surface === "global" ? "A1" : "A2", workspaceId: surface === "global" ? "w2" : "w1", title: "Second ask", body: "Second details" })];
      const root = <AsksView theme={theme} compact={false} workspaceId={surface === "workspace" ? "w1" : undefined} />;
      const first = surface === "workspace" ? "A1: First ask" : "First ask, First workspace";
      const second = surface === "workspace" ? "A2: Second ask" : "Second ask, Second workspace";
      // When
      render(root).button(first).props.onPress();
      render(root).button(second).props.onPress();
      const page = render(root);
      // Then
      expect(page.text).toContain("First details");
      expect(page.text).toContain("Second details");
      expect(page.text).toContain("Recommended choice ★");
      expect(page.button("Recommended choice ★").props.style).toContainEqual(expect.objectContaining({ backgroundColor: theme.colors.accent }));
      page.button(first).props.onPress();
      const collapsed = render(root);
      expect(collapsed.text).not.toContain("First details");
      expect(collapsed.text).toContain("Second details");
    },
  );

  it.each(["```", "~~~~", "    ```", "\t```"])(
    "Given prose around a %s fenced code block, When rendered, Then code wraps as text and prose still uses host Markdown",
    (fence) => {
      // Given
      const code = `  indented value\n${"long_unbroken_identifier".repeat(12)} <literal>`;
      const source = `Before **bold**\n\n${fence}text\n${code}\n${fence}\n\nAfter [link](https://example.com)`;
      // When
      const page = render(<Markdown theme={theme}>{source}</Markdown>);
      // Then
      const prose = page.nodes.filter((node) => node.type === "Markdown");
      expect(prose.map((node) => node.props.children)).toEqual(["Before **bold**\n", "\nAfter [link](https://example.com)"]);
      const codeText = page.nodes.find((node) => node.type === "Text" && node.props.children === code);
      expect(codeText).toBeDefined();
      expect(codeText!.props.style).toEqual(expect.arrayContaining([
        expect.objectContaining({ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }),
      ]));
      expect(page.nodes.some((node) => node.type === "ScrollView")).toBe(false);
    },
  );

  it("Given fenced code in an ask body, When its workspace row opens, Then the card uses wrapping text", () => {
    // Given
    const code = "a-long-token".repeat(20);
    host.asks = [ask({ body: `Prose\n\n\`\`\`text\n${code}\n\`\`\`` })];
    const root = <AsksView theme={theme} compact={true} workspaceId="w1" />;
    // When
    render(root).button("A1: First ask").props.onPress();
    const page = render(root);
    // Then
    expect(page.nodes.some((node) => node.type === "Markdown" && String(node.props.children).includes(code))).toBe(false);
    expect(page.nodes.find((node) => node.type === "Text" && node.props.children === code)?.props.style).toEqual(expect.arrayContaining([
      expect.objectContaining({ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }),
    ]));
  });
});
