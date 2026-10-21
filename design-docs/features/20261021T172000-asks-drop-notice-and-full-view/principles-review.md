# Principles review: asks drop notice and full view

Date: 2026-10-21. Scope: the merged change (`69b8341`, `ec8e58f`) and the follow-up collapsed-list fix.

## Verdict

The drop-notice fix (server) passes. The view change (client) failed several principles and is being redone.

## Agentic workflow principles

| Principle | Result | Evidence |
|---|---|---|
| Hardening | Pass (server) | `service.act` refuses closed asks with a named error; 6 tests were red before the fix; the live `/act` check showed the refusal. |
| Observability | Pass | Every human act writes a line to `act-log.jsonl` with `before`, `after`, `delivery`, `error`. |
| Strategic Human Gate | Weak | The merge card came before Wesley could review the diff. It reported checks, not the diff, so it did not invite review. |
| Disposable Blueprint | Fail | No plan was saved and reviewed before the UI code. The results doc came after. |
| Specialized Review | Fail | No reviewer read the diff. The browser check ran on a preview whose popover frame was 440 wide with no host limits, so it could not see the real cut-off. |
| Institutional Memory | Fail, now fixed | The lesson is that the preview must mirror the host popover limits. It is now code: `HostPopover` in `preview/main.tsx`. |
| Token Economy | Pass | About $3.3 for the session; small browser checks only. |

## Core design principles

| Principle | Result | Evidence |
|---|---|---|
| Modular Design | Fail, now fixed | The popover had its own always-open path in `AskRow`. It now uses the same `AskSections` list as the sidebar. |
| MVP / scope | Fail | "See the entire ask" was read as "always expand every ask". Nobody asked for that. |
| Format/Interface Design | Fail, now fixed | A fixed `width: 420` and our own `ScrollView` (maxHeight 520) sat inside a host popover that is already `minWidth 280, maxWidth 420, maxHeight 440, scrollable`. The host padding pushed the content past the right edge. |
| Safety-First | Pass | Closed asks are refused; a drop with no live owner shows a warning. |
| Data-First | Pass | `delivery` is a typed enum in the shared schema. |
| Deterministic Offloading | Pass | The pill count comes from one shared `pillLabel` function, covered by tests. |

## Host limit source

The host popover limits come from `/Applications/Paseo.app/Contents/Resources/app-dist/_expo/static/js/web/index-3d91adc9929fc38d33c6f16e7811ed52.js`, line 17726: `minWidth:280,maxWidth:420,maxHeight:440,scrollable:!0`. The composer pill popover cannot be wider than 420, and its content props have no navigation, so it cannot open the wide Asks screen.
