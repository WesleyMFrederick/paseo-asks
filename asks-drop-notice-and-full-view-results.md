# Asks: drop notice and full view — results

Date: 2026-10-21. Branch `fix/drop-notice-and-full-view` (worktree `~/.paseo/plugin-src/paseo-asks-fix`), commits `a0f94dc` (server) and `da2d6cd` (UI). **Not live**: Paseo loads the plugin from the main checkout `~/.paseo/plugin-src/paseo-asks`; it goes live only after a merge to main and `paseo plugin reload paseo-asks`, both Wesley's call.

## Quick scan

| Row | Measure | Baseline (main `617c145`) | Target | After (branch) |
|---|---|---|---|---|
| MoE 1 | Human drops an ask: owner gets one notice, human sees who heard | Notice queued, human sees nothing; a second drop re-sent it (owner got the same line twice) | One notice; toast names sent / queued / nobody | Replay of the real incident: 1 notice; drop #1 returns `queued`; drop #2 refused |
| MoE 2 | Popover is readable and matches the sidebar | Title cut to 1 line; popover cut off on the right | Same collapsible rows as the sidebar; titles wrap; nothing past the right edge | Run 5: rows start collapsed, titles wrap, every card ends 9px inside the 420px host popover |
| MoE 3 | Pill count matches popover | Pill counts `open` only; popover lists `open`+`in_progress` → "No asks" next to A3 | Same set | Shared `pillLabel`: "Asks · 1 in progress" |
| MoP 1 | Acts on a closed ask that change or re-send anything | 1 of 2 human drops on 2026-10-21 (outbox, 17:10:53Z) | 0 | 0 (error "A2 is already dropped; nothing was changed or sent") |
| MoP 2 | Human acts with a logged outcome | 0 (no log) | 100% | 100%: `act-log.jsonl`, one line per act, applied or refused |
| MoP 3 | Tests | 32 pass | all pass, new ones red first | 36 pass (6 new/changed were red before the fix); typecheck clean |

**Z metric:** human acts on an ask whose outcome the human cannot see (no confirmation of who heard, or a silent duplicate). Baseline: 2 of 2 on 2026-10-21 (both drops of A2 in `wks_7b898…`). Ideal: 0. After: 0 in the replay; live count waits on the reload.

**Log:** `~/.paseo/plugin-data/asks/act-log.jsonl` (new). Fields: `at`, `workspaceId`, `id`, `verb`, `actionId?`, `note?`, `ownerAgentId`, `before`, `after?`, `delivery?` (`sent`|`queued`|`nobody`), `error?`. Notices themselves: `~/.paseo/plugin-data/asks/outbox.json`, fields `id, agentId, workspaceId, askId, text, createdAt, state, attempts, error`.

## What actually happened (root cause)

From `outbox.json`, `workspaces/*.json` and both agents' session logs:

1. **Two asks named A2.** Ids count per workspace. The CoS owned A2 "Merge OK waiting…" in `wks_5647…`; agent `6bb12c05` ("Harden: CoS tldr reply") owned A2 "CoS long replies…" in `wks_7b898…`. Wesley's drops hit the second one.
2. **The drop did save and was delivered**, to `6bb12c05`, at 17:17:55Z — 7 and 11 minutes late, because that agent was mid-turn and the outbox waits for idle (by design: a mid-turn send interrupts).
3. **Nothing told Wesley that.** `act()` answered `notified: true` for a merely queued notice; the UI toasts only on `!notified`. So the press looked like it did nothing.
4. **The second press was accepted on an already-dropped ask** and queued the same notice again; the agent got the line twice.
5. The CoS's own A2 stayed open until the CoS dropped it itself (`ask_update`, 17:07:09Z), so from the CoS's seat the drop looked lost.

Popover: `AskRow` clamped the title to one line and rendered `AskDetail` only after a tap; `AgentAsks` started collapsed. Pill: `refreshCounts` counted `status === "open"` only.

## Design (codebase-design skill)

Followed `cc-workflows-plugin/.agents/skills/codebase-design/SKILL.md` and `DESIGN-IT-TWICE.md`.

- **A — deep `act()` (chosen).** One server interface owns the whole disposal: refuse closed asks, save, enqueue, flush, and answer with the delivery state; it logs every call. The client just shows the answer. Depth: high (one call hides store + outbox + courier). Locality: the rule "closed asks can't be acted on" lives in one place and also protects the MCP side chats and any future caller. Seam: the existing `AsksService` / `Outbox` boundary; tests use the real store and outbox with a fake courier.
- **B — client-side guard and confirm.** Disable buttons on closed asks and add "are you sure / sent" UI. Shallow: the server still accepts duplicates from a stale view, a second tab, or the phone; the "who heard" answer would be guessed by the client. Rejected.

Pill: one exported `pillLabel(asks, agentId)` in `shared/asks.ts`, using the same owner + open/in-progress filter as the popover, so the two cannot drift again.

## What changed

- `server/service.ts`: `act()` refuses closed asks (`"<id> is already <status>; nothing was changed or sent"`), awaits the owner's flush, returns `delivery: "sent" | "queued" | "nobody"`, logs each act. `notify()` returns the outbox entry.
- `server/outbox.ts`: `state(id)`.
- `shared/asks.ts`: `actOnAsk` output `{ ask, delivery }`; `pillLabel`.
- `index.server.ts`: writes `act-log.jsonl`.
- `index.client.tsx`: pill uses `pillLabel`.
- `client/AsksView.tsx`: one shared `AskSections` list (collapsed rows, tap to open) for the panel, the global screen and the pill popover. Titles wrap instead of truncating. The popover has no width or ScrollView of its own, because the host already sizes it (280–420 wide) and scrolls it (max 440 high). Toast after every act says who heard (warning if nobody); error toast on refusal; in-progress asks keep their close/open actions.
- Correction after Wesley's review: the first version kept every popover ask fully open (not asked for) and set a fixed 420 width inside the host's 420 cap, so the host padding cut off the right side. See [principles-review.md](design-docs/features/20261021T172000-asks-drop-notice-and-full-view/principles-review.md).
- Width (Wesley: wider on wide displays, narrower on phone): no setting or plugin option widens the popover. Two search agents checked Paseo main and the 0.12 plugin kit; see [width-research.txt](design-docs/features/20261021T172000-asks-drop-notice-and-full-view/research/host-popover-width/width-research.txt). Wesley picked the plugin-only fix: on wide layouts the popover shows **Open wide**. It closes the popover and calls `client.openPanel("asks", { workspaceId, agentId })`, which opens the Asks panel beside the chat (`index.client.tsx` `pillPopover`). On phones (`layout.compact`) there is no Open wide, and Paseo shows the pill as a bottom sheet.
- README, preview mock, preview popover frame, `docs/popover.png`.

## Checks run

- `npm test`: 36/36 (baseline 32). Red-first: 6 failed before the fix (delivery field, closed-ask refusal, same-id-two-workspaces, pill label ×3).
- `npm run typecheck`: clean.
- Replay on a copy of the real asks data, owner mid-turn, two drops:
  - main: drop #1 → no delivery info; drop #2 accepted; owner got the notice **twice**; no log.
  - branch: drop #1 → `queued`; drop #2 → refused; owner got it **once**; two log lines (applied, refused). CoS's A2 in the other workspace untouched.
- Popover rendered with react-native-web in `preview/` (the plugin's own screenshot harness): full title, body, code block, list, links, option buttons, note box, Reply/Done/Drop/Discuss all visible without a tap.
- Independent browser-agent check on that preview, starting from a fresh page with nothing clicked:
  - Run 1 **FAILED** on two points. After Drop, the toast said "Sent A1…": the word came from the returned status, which a stale or mocked answer can leave unchanged. Also, A3's long code line was cut off at the right edge, because code blocks scrolled sideways.
  - Fix (`client/AsksView.tsx`, `client/Markdown.tsx`): the toast word now comes from the button pressed, and code blocks wrap.
  - Run 2 **PASSED**: A3, A1, A4 and A2 are all in full with no text clipped (no element wider than its box). Drop on A1 logged exactly "Dropped A1. Its agent has been told." Evidence: `design-docs/features/20261021T172000-asks-drop-notice-and-full-view/research/ui-check/` (run 1) and `…/recheck/` (run 2).
  - Run 3 (`…/final/`) cited its evidence to single lines, but only in text files. It had no screenshots, and the toast showed up only as a console line.
  - Run 4 (`…/toast/`) **PASSED** with screenshots. The preview's toast stand-in is now an on-screen banner (`preview/mocks/react-native.tsx`); Paseo's real toast is a host component. It saved:
    - `popover-top/middle/bottom.png`: the whole popover, scrolled within its 520px box;
    - `toast.png`: the banner "Dropped A1. Its agent has been told." on screen after Drop;
    - `toast.txt`: the toast text, `computed visibility: visible`, and the rect inside the 900px viewport.
- **Live, after Wesley's OK** (2026-10-21 17:42Z): local main was fast-forwarded to `69b8341`, and `paseo plugin reload paseo-asks` brought it back as `running`. I created test ask A2 in `wks_97ff0e9b0cf068b3` and dropped it twice via the plugin's `/act` (the same `service.act` the UI calls).
  - Drop #1 returned `{"status":"dropped","delivery":"queued"}`; the owner was mid-turn.
  - Drop #2 was refused.
  - `act-log.jsonl` got two lines: `"before":"open","after":"dropped","delivery":"queued"`, then `"before":"dropped","error":"A2 is already dropped; nothing was changed or sent"`.
  - Paseo's own toast on screen is not yet seen. That needs Wesley's next drop in the app.
- Run 5 (`…/collapsed/`) **PASSED** on the preview, which now mirrors the host popover limits (`HostPopover` in `preview/main.tsx`). Rows start collapsed in both popover and panel. The two-line title wraps. Each card's right edge sits 9px inside the popover, collapsed and expanded. A second tap collapses the row.
- Run 7 (`…/width/`) **PASSED** on the preview at 1600×1000. The popover is 420 wide and shows Open wide; the phone pill has no Open wide. After pressing it, the popover is gone and the panel is 900 wide. Calling `openPanel` from the popover in the real app is not yet seen.

## Side finding: "Timed out waiting for OMP to become ready"

No cause beyond load found. At 10:26 local the load was 7.10 / 35.40 / 41.95 with 120 omp-matching processes (41 Chrome helpers, 33 `~/.bun/bin/bun`, 17 `bun`, 8 Puppeteer Chrome). The 4 timeouts happened at a 1-minute load near 120, so a fixed readiness timeout under CPU starvation is the likely story [INFERENCE]; plugin logs show nothing related. Falsify by: start an agent when the 1-minute load is under 10; a timeout then means it is not load.

## Cost

No worker agents and no Jev calls. This session cost about $3.25 through the first report. The planner consult cost $0.04. The two browser-agent checks were small read-only runs.

## Open risks

- The pill popover itself still cannot be wider than 420: that is a Paseo host limit. Open wide hands off to the Asks panel, which shows the whole workspace, not only that agent's asks.
- Sidebar count still counts `open` only (asks waiting on Wesley); in-progress ones wait on the agent. Left as is.
- Same-id confusion across workspaces is explained in the README but ids are still per workspace; renaming them would break agents' existing references.

## Duplicate popover: cause found (2026-10-21)

Symptom (Wesley): one click on the Asks pill shows the popover at the pill and again at the top-left.

Method: a temporary one-time check inside the plugin (commits 7bb1e30, add881a), merged and reloaded with Wesley's OK. Run 1 failed loudly and saved no detail. Run 2 saved the full census: `design-docs/features/20261021T172000-asks-drop-notice-and-full-view/research/host-popover-width/popover-census-run2.json`.

Findings from run 2:
- 20 Asks pills were mounted for 10 workspaces, 2 per workspace. Only 1 was on screen (x 342, y 894). The other 19 sit inside hidden containers and measure 0,0,0,0.
- The current workspace (`wks_82129821112f13d3`) had **two** pills. Both had the same pill entry (key 342, id `asks`), the same agent, and the same deck entry. Both had `active: true` on every panel and deck flag, and `isRouteFocused: true`.
- The only difference was the route instance: `workspace/[workspaceId]/index-QvyfjJkc…` (visible) vs `workspace/[workspaceId]/index-V_Xqq2gpq…` (hidden). So the navigation stack holds two copies of the same workspace screen, and both believe they are the active one.

Cause (the advisor's H-A, confirmed): the pill's open state is shared per entry, so one click opens both menus. The hidden copy's popover still draws, because its panel says active, and it portals out of the hidden screen. Its trigger measures 0,0, so it lands at the top-left. This matches the Paseo comment that repeated `/new` to workspace hops "append hidden deck entries". H-B (one menu, extra DOM copy) and H-C (stale registrations after reload) are refuted: the two pills belong to two live route instances, not to one menu or an old registration.

Where the bug lives: the Paseo host (route stack plus `MenuSurface` gating on panel active only), not the plugin. Not fixed upstream as of `origin/main` (no changes to the menu, retained-panel or workspace-route files since v0.12.0).

Side note: none of the check's synthetic presses opened the menu. The host's pressable uses the responder system, which ignores synthetic clicks. That does not affect the result, because the census of the mounted pills alone decides the cause.
