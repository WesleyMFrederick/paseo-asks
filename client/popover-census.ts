/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// TEMPORARY diagnostic (remove after the duplicate-popover cause is known).
// Opens the visible Asks pill once, counts popover surfaces and which React owner each belongs to, then closes it.
import type { ComponentType } from "react";

const DONE_KEY = "asks.popover-census.v2";
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

/** The press handler names on the trigger's fiber chain, so a miss says what the host actually wired. */
function handlerNames(trigger: Element): { hasFiber: boolean; reactKeys: string[]; handlers: string[] } {
  const handlers = new Set<string>();
  for (let fiber = fiberOf(trigger), depth = 0; fiber && depth < 30; fiber = fiber.return, depth++) {
    for (const key of Object.keys(fiber.memoizedProps ?? {})) if (/^on[A-Z]/.test(key)) handlers.add(`${depth}:${key}`);
  }
  return { hasFiber: fiberOf(trigger) !== null, reactKeys: Object.keys(trigger).filter((key) => key.startsWith("__react")), handlers: [...handlers] };
}

function pressViaProps(trigger: Element): boolean {
  for (let fiber = fiberOf(trigger); fiber; fiber = fiber.return) {
    const onPress = fiber.memoizedProps?.onPress;
    if (typeof onPress === "function") {
      (onPress as () => void)();
      return true;
    }
  }
  return false;
}

/** Every rendered copy of the popover's "Refresh asks" text: the symptom itself, independent of host selectors. */
function popoverCopies(Popover: ComponentType<never>) {
  const copies = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const holder = node.parentElement;
    if (!holder || node.textContent?.trim() !== "Refresh asks") continue;
    const surface = holder.closest("[data-menu-surface='true']");
    copies.push({ ...describe(holder), inMenuSurface: surface !== null, popovers: popoverInstances(holder, Popover), portalRootChild: topLevelChild(holder) });
  }
  return copies;
}

/** Which direct child of <body> holds the node, e.g. the app root or the menu overlay portal. */
function topLevelChild(node: Element): string {
  let el: Element = node;
  while (el.parentElement && el.parentElement !== document.body) el = el.parentElement;
  return `${el.tagName}#${el.id} ${el.getAttribute("data-testid") ?? ""} index=${[...document.body.children].indexOf(el)}`.trim();
}

function snapshot(Popover: ComponentType<never>) {
  return {
    surfaces: surfaces().map((surface) => ({ ...describe(surface), popovers: popoverInstances(surface, Popover), text: surface.textContent?.slice(0, 80) })),
    copies: popoverCopies(Popover),
  };
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
    const before = { triggers: triggers().map((el) => ({ ...describe(el), ...handlerNames(el), tag: el.tagName, role: el.getAttribute("role") })), ...snapshot(Popover) };
    // Static views (the asks panel) also show "Refresh asks", so a press counts only when it adds copies or surfaces.
    const baseline = before.surfaces.length + before.copies.length;
    const opened = () => surfaces().length + popoverCopies(Popover).length > baseline;
    // Try each press path in turn and record what each one produced; never stop at the first miss.
    const attempts: Record<string, unknown>[] = [];
    (visible as HTMLElement).click();
    await sleep(2_000); // past the entering animation and its 750 ms cleanup
    attempts.push({ method: "click", opened: opened(), ...snapshot(Popover) });
    if (!opened()) {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        visible.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0 }));
      }
      await sleep(2_000);
      attempts.push({ method: "pointer-sequence", opened: opened(), ...snapshot(Popover) });
    }
    if (!opened()) {
      const called = pressViaProps(visible);
      await sleep(2_000);
      attempts.push({ method: called ? "onPress" : "onPress-missing", opened: opened(), ...snapshot(Popover) });
    }
    closeMenu();
    await sleep(800);
    if (surfaces().length > before.surfaces.length) {
      pressViaProps(visible);
      await sleep(800);
    }
    census = {
      ok: attempts.some((attempt) => attempt.opened === true),
      userAgent: navigator.userAgent,
      href: location.href,
      bodyChildren: [...document.body.children].map((el) => `${el.tagName}#${el.id}`),
      before,
      attempts,
      afterClose: snapshot(Popover),
    };
  } catch (error) {
    census = { ok: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error), href: typeof location === "undefined" ? null : location.href };
  }
  localStorage.setItem(DONE_KEY, new Date().toISOString());
  await report(census);
}
