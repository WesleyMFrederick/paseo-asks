# Asks: drop notice and full view — results

Date: 2026-10-21. Branch `fix/drop-notice-and-full-view` (worktree `~/.paseo/plugin-src/paseo-asks-fix`), commits `a0f94dc` (server) and `da2d6cd` (UI). **Not live**: Paseo loads the plugin from the main checkout `~/.paseo/plugin-src/paseo-asks`; it goes live only after a merge to main and `paseo plugin reload paseo-asks`, both Wesley's call.

## Quick scan

| Row | Measure | Baseline (main `617c145`) | Target | After (branch) |
|---|---|---|---|---|
| MoE 1 | Human drops an ask: owner gets one notice, human sees who heard | Notice queued, human sees nothing; a second drop re-sent it (owner got the same line twice) | One notice; toast names sent / queued / nobody | Replay of the real incident: 1 notice; drop #1 returns `queued`; drop #2 refused |
| MoE 2 | Popover shows the whole ask without a tap | Title cut to 1 line; body, links, options, Reply/Done/Drop hidden until tap | All visible | All visible (see `docs/popover.png`) |
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
- `client/AsksView.tsx`: popover rows always fully open; toast after every act says who heard (warning if nobody); error toast on refusal; in-progress asks keep their close/open actions (send options hidden, already chosen).
- README, preview mock, preview popover frame, `docs/popover.png`.

## Checks run

- `npm test`: 36/36 (baseline 32). Red-first: 6 failed before the fix (delivery field, closed-ask refusal, same-id-two-workspaces, pill label ×3).
- `npm run typecheck`: clean.
- Replay on a copy of the real asks data, owner mid-turn, two drops:
  - main: drop #1 → no delivery info; drop #2 accepted; owner got the notice **twice**; no log.
  - branch: drop #1 → `queued`; drop #2 → refused; owner got it **once**; two log lines (applied, refused). CoS's A2 in the other workspace untouched.
- Popover rendered with react-native-web in `preview/` (the plugin's own screenshot harness): full title, body, code block, list, links, option buttons, note box, Reply/Done/Drop/Discuss all visible without a tap.
- **Not verified on the live Paseo surface** — that needs the merge and plugin reload.

## Side finding: "Timed out waiting for OMP to become ready"

No cause beyond load found. At 10:26 local the load was 7.10 / 35.40 / 41.95 with 120 omp-matching processes (41 Chrome helpers, 33 `~/.bun/bin/bun`, 17 `bun`, 8 Puppeteer Chrome). The 4 timeouts happened at a 1-minute load near 120, so a fixed readiness timeout under CPU starvation is the likely story [INFERENCE]; plugin logs show nothing related. Falsify by: start an agent when the 1-minute load is under 10; a timeout then means it is not load.

## Cost

No worker agents, no Jev calls. Only this session's tokens.

## Open risks

- The popover's `maxHeight: 520` now scrolls through fully open asks; with many long asks Wesley scrolls more. Chosen over hiding content.
- Sidebar count still counts `open` only (asks waiting on Wesley); in-progress ones wait on the agent. Left as is.
- Same-id confusion across workspaces is explained in the README but ids are still per workspace; renaming them would break agents' existing references.
