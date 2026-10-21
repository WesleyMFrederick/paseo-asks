/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// TEMPORARY diagnostic (remove after the duplicate-popover cause is known).
// Opens the visible Asks pill once, counts popover surfaces and which React owner each belongs to, then closes it.
import type { ComponentType } from "react";

const DONE_KEY = "asks.popover-census.v1";
const PILL_TEXT = /^(Asks · |No asks)/;
const OWNER_PROPS = ["agentId", "workspaceId", "serverId", "active", "isRouteFocused", "visible", "testID", "compact", "recoveryRequested"];

type Fiber = { return: Fiber | null; memoizedProps?: Record<string, unknown> | null; type?: unknown; key?: string | null; alternate?: Fiber | null };

// The project's lib predates Promise.withResolvers, so the executor form stays.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Stable id per popover component instance; React swaps a fiber with its alternate on each commit. */
const instanceIds = new WeakMap<Fiber, string>();

function fiberOf(node: Element): Fiber | null {
  const key = Object.keys(node).find((name) => name.startsWith("__reactFiber$"));
  return key ? ((node as unknown as Record<string, Fiber>)[key] ?? null) : null;
}

function shallow(value: unknown): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const key of ["key", "name", "serverId", "workspaceId", "agentId", "id"]) if (key in record) picked[key] = record[key];
    return picked;
  }
  return typeof value;
}

/** The owner chain above a DOM node: React keys and the few props that tell two chat copies apart. */
function ownerChain(node: Element): { keys: string[]; props: Record<string, unknown>[] } {
  const keys: string[] = [];
  const props: Record<string, unknown>[] = [];
  for (let fiber = fiberOf(node), depth = 0; fiber && depth < 2000; fiber = fiber.return, depth++) {
    if (fiber.key) keys.push(fiber.key);
    const memo = fiber.memoizedProps;
    if (!memo || typeof memo !== "object") continue;
    const picked: Record<string, unknown> = {};
    for (const key of OWNER_PROPS) if (key in memo) picked[key] = shallow(memo[key]);
    for (const key of ["entry", "selection", "route"]) if (key in memo) picked[key] = shallow(memo[key]);
    if (Object.keys(picked).length) props.push({ depth, ...picked });
  }
  return { keys, props: props.slice(0, 40) };
}

function hiddenAncestor(node: Element): string | null {
  for (let el: Element | null = node; el; el = el.parentElement) {
    if (getComputedStyle(el).display === "none") return `${el.tagName} ${el.getAttribute("data-testid") ?? ""}`.trim();
  }
  return null;
}

function describe(node: Element) {
  const rect = node.getBoundingClientRect();
  return {
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    hiddenAncestor: hiddenAncestor(node),
    deckEntry: node.closest("[data-testid^='workspace-deck-entry-']")?.getAttribute("data-testid") ?? null,
    owner: ownerChain(node),
  };
}

const triggers = () =>
  [...document.querySelectorAll("[aria-expanded]")].filter((el) => PILL_TEXT.test(el.textContent?.trim() ?? ""));
const surfaces = () => [...document.querySelectorAll("[data-menu-surface='true']")];

/** Every popover content instance of ours under a surface, found by component identity in the fiber tree. */
function popoverInstances(surface: Element, Popover: ComponentType<never>): string[] {
  const found = new Set<string>();
  for (const el of [surface, ...surface.querySelectorAll("*")]) {
    for (let fiber = fiberOf(el); fiber; fiber = fiber.return) {
      if (fiber.type === Popover) {
        const id = instanceIds.get(fiber) ?? (fiber.alternate && instanceIds.get(fiber.alternate)) ?? `popover-${Math.random().toString(36).slice(2, 8)}`;
        instanceIds.set(fiber, id);
        if (fiber.alternate) instanceIds.set(fiber.alternate, id);
        found.add(id);
        break;
      }
    }
  }
  return [...found];
}

function pressViaProps(trigger: Element): string {
  for (let fiber = fiberOf(trigger); fiber; fiber = fiber.return) {
    const onPress = fiber.memoizedProps?.onPress;
    if (typeof onPress === "function") {
      (onPress as () => void)();
      return "onPress";
    }
  }
  throw new Error("CensusError: no onPress above the Asks pill");
}

function closeMenu(): void {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

export async function runPopoverCensus(
  Popover: ComponentType<never>,
  report: (census: Record<string, unknown>) => Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  if (typeof document === "undefined" || typeof localStorage === "undefined") return;
  if (localStorage.getItem(DONE_KEY)) return;
  const started = Date.now();
  let census: Record<string, unknown>;
  try {
    let visible: Element | undefined;
    while (!signal.aborted && Date.now() - started < 10 * 60_000) {
      visible = triggers().find((el) => el.getClientRects().length > 0 && !hiddenAncestor(el));
      if (visible && surfaces().length === 0) break;
      visible = undefined;
      await sleep(5_000);
    }
    if (signal.aborted) return;
    if (!visible) throw new Error("CensusError: no visible Asks pill within 10 minutes");
    const before = { triggers: triggers().map(describe), surfaces: surfaces().length };
    // A DOM click is the user's path; the props call covers a Pressable that ignores synthetic clicks.
    (visible as HTMLElement).click();
    let method = "click";
    await sleep(800);
    if (surfaces().length === 0) {
      method = pressViaProps(visible);
      await sleep(800);
    }
    await sleep(1_200); // past the entering animation and its 750 ms cleanup
    const open = surfaces().map((surface) => ({ ...describe(surface), popovers: popoverInstances(surface, Popover), text: surface.textContent?.slice(0, 80) }));
    closeMenu();
    await sleep(600);
    if (surfaces().length > 0) pressViaProps(visible);
    await sleep(600);
    census = {
      ok: true,
      method,
      userAgent: navigator.userAgent,
      href: location.href,
      before,
      pressed: describe(visible),
      open,
      afterClose: surfaces().length,
    };
  } catch (error) {
    census = { ok: false, error: error instanceof Error ? error.message : String(error), href: typeof location === "undefined" ? null : location.href };
  }
  localStorage.setItem(DONE_KEY, new Date().toISOString());
  await report(census);
}
