# Asks status follows the owner's run state

## Baseline (measured 2026-10-22)
- The CoS final-reply check log has 39 checks. 10 of them fired `CosStaleAskError` (8 with 1 stale ask, 2 with 2), so 12 stale asks in total. The log stores only counts, not reasons, so the `owner-running` share is unknown. The CoS reported 4 `owner-running` loops today (A11, A12, A14, A15), plus A7 in this tab.
- Every fix today is manual: a message relayed by a human tells the owner to run `ask_update in_progress`, then `open`. That message wakes the owner, and the loop repeats.

## Ideal
An ask's stored status follows its owner's run state with zero manual flips: `in_progress` while the owner runs, `open` while it is idle.

## Design (codebase-design SKILL.md + DESIGN-IT-TWICE.md)
- **A (chosen): store the derived status.** One plugin module (`server/run-status.ts`) flips the stored status:
  - on `agent.turn_started` and `agent.turn_ended`;
  - on owner tool calls (a tool call means the owner is mid-turn);
  - in a 20 s reconcile pass that catches missed events and reloads.
  `autoStatus` marks the flips the plugin may undo, so an `in_progress` set by a human "send" stays put. Every reader (ask_list, pill, nudge, the CoS check) still reads the stored field.
  - Deep: the rule lives in one module.
  - Seam: the store file already shared with the CoS check.
- **B (rejected): compute the status at read time.** Every reader would combine the stored status with run state:
  - the plugin client, ask_list, nudge and the PR watcher would each need run state;
  - the CoS check (another repo) would repeat the rule.
  That puts the rule in two codebases, which can drift, and the in-memory run state is lost on reload.
- CoS check: `owner-running` stays as a safety net. Its notice now says "do not message that tab; report it to the harness engineer", which breaks the loop even if the automation misses.

## Delta hypothesis
If the plugin flips stored ask status from owner turn events, owner calls and a reconcile pass, then an open ask never sits beside a running owner. That should move manual open/in_progress flips per day from about 5 to 0.

**Falsify by:** after the reload, any `CosStaleAskError` notice with "the asks plugin missed setting it in progress" in the next 20 CoS checks refutes the hypothesis. Bar set before the run: 0 fires.

**Risky assumption:** Paseo's agent record turns `lastStatus: running` at about the same moment `agent.turn_started` fires. If the record leads by more than the check's timing, rare false fires stay possible.

## Live (2026-10-22, Wesley picked "Turn it on now")
- Merged: plugin main 61604b2 (includes the census removal); cc-workflows main 3d2348d9 (pushed). Tests on main: plugin 47/47, cos-output 185/185. Plugin reloaded, `paseo plugin ls` says running.
- Live check: the owner set A7 `open` mid-turn and the plugin stored `in_progress`, `autoStatus: true`. At that moment only one agent was running, and every other open ask had an idle owner, so the store matched the run state. Not yet seen: a `turn_ended` flip back to open in `status-flip-log.jsonl` (the first one comes when this tab's turn ends).
