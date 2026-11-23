# Upstream catch-up — November 2026

## Scope and safety

Merge local main `906104304a7645ce8f10cd3bc88c36c31381b48c` with upstream main `d37f96166f198fc32a931b0027691d10d63b7c63` in the separate `chore/catch-up-upstream` worktree. The live main checkout and daemon are not switched or reloaded.

Fork: https://github.com/WesleyMFrederick/paseo-asks. `upstream` is https://github.com/fullstackhouse/paseo-asks; `origin` is the fork. GitHub created fork main from upstream, so pushing the divergent local main was rejected without changing it. The approved backup is `backup/local-main-2026-11`, which points to the exact original local main. Six other local branches are backed up under their own names. `fix/refresh-covers-pill` (`176a8a1`) is backed up only, not merged.

This is a merge, not a history rewrite: “dropped” below means the resulting implementation uses upstream's behavior, not that the historical commit disappears. Documentation and diagnostic commits remain historical evidence, not a claim that old screenshots or status designs describe today's UI.

## Decisions for every local-only commit

The inventory is `git log --reverse upstream/main..9061043`, including merge commits. Upstream pull-request links name the replacing behavior where applicable.

| Local commit | Decision | Reason |
|---|---|---|
| `a0f94dc` refuse closed acts; report delivery | adapted | Preserve closed-ask refusal, delivery feedback and action logging while using upstream steering and waiting-on-you lifecycle. |
| `da2d6cd` full composer ask | dropped (covered by upstream [#69](https://github.com/fullstackhouse/paseo-asks/pull/69), [#71](https://github.com/fullstackhouse/paseo-asks/pull/71)) | Use upstream live chat cards and simplified full-content cards instead of the older composer-only rendering. |
| `79445ad` drop/full-view results | kept | Retain the historical verification record. |
| `2e6274d` named toast; wrapped code | adapted | Preserve action-specific delivery feedback; host Markdown replaces the plugin renderer and its wrapping patch. |
| `7649502` browser-check results | kept | Retain the historical verification record. |
| `eb936cc` browser evidence | kept | Retain the historical verification record. |
| `69b8341` preview toast | adapted | Keep preview delivery feedback with the current upstream mock host interface. |
| `ec8e58f` live-check record | kept | Retain the historical verification record; no live reload is performed by this catch-up. |
| `19dff52` collapsible list | adapted | Use upstream simplified cards and list ordering while preserving relay-driven expansion and cross-workspace context. |
| `d3e78b7` collapsed-list evidence | kept | Retain the historical verification record. |
| `3a1d845` Open wide | adapted | Preserve the wide-panel escape from the capped composer popover alongside upstream host navigation. |
| `7bb1e30` temporary popover census | kept | Preserve historical diagnostics only; the later local removal leaves no instrumentation in the merged implementation. |
| `add881a` census v2 | kept | Preserve historical diagnostics only; the later local removal remains effective. |
| `df6643d` remove census | kept | Keep the removal of temporary instrumentation and its recorded cause. |
| `a597956` post-census UI check | kept | Retain the historical verification record. |
| `69f41d1` post-census check 3 | kept | Retain the historical verification record. |
| `95a6028` wide/phone sign-off | kept | Retain the historical user sign-off without treating it as fresh catch-up verification. |
| `03dba06` recorded-card nudge suppression | adapted | Keep decision-id/title matching, scoped to relevant asks, alongside upstream [#68](https://github.com/fullstackhouse/paseo-asks/pull/68) workspace-aware ids and asynchronous classifier. |
| `3c5338b` merge main into UI branch | kept | Preserve merge ancestry; its constituent behavior is classified separately. |
| `4df7b7a` automatic run-state status | dropped (covered by upstream [#76](https://github.com/fullstackhouse/paseo-asks/pull/76)) | Upstream's human-wait lifecycle replaces automatic running/idle flips; delete the old module, hooks, flags and obsolete tests. |
| `61604b2` merge automatic status | dropped (covered by upstream [#76](https://github.com/fullstackhouse/paseo-asks/pull/76)) | Keep ancestry but not the superseded auto-status implementation. |
| `2c8c92f` auto-status live results | kept | Preserve historical evidence; README explicitly marks the old design superseded. |
| `7ea8f59` invalidate cached PR on relink | kept | Preserve immediate store invalidation; upstream [#53](https://github.com/fullstackhouse/paseo-asks/pull/53) separately fixes watcher comparisons, so the defenses complement each other. |
| `1fafb92` relayed asks | kept | Upstream's discussion workspace is not a general relay; keep persisted arbitrary readers and cross-workspace composer visibility. |
| `4484060` relay locking/batches/actions | adapted | Retain validation under workspace locks and independent reader batches; remove the obsolete auto-status action exception. |
| `bf1581e` auto CAS; newest relay batch | adapted | Keep newest-batch recency and closed-ask metadata; remove auto-status compare-and-set machinery superseded by upstream. |
| `f070082` atomic send claim | kept | Keep check-and-claim under the store lock so concurrent presses cannot queue duplicate sends. |
| `32fda00` relayed phone preview | adapted | Retain the cross-workspace relay sample using the upstream card and preview host interfaces. |
| `9061043` orphan admin reassignment/close | kept | Preserve authenticated admin recovery and action-log entries, which upstream does not provide. |

Summary: **29 local-only commits: 17 kept, 3 dropped, 9 adapted**. Historical merge and evidence commits count as kept even when the behavior they document has since changed.

## Resulting behavior

Upstream owns waiting-on-you status, native question and chat cards, shared Markdown, discussion workspaces, Show in chat, snoozed counts, workspace summaries, PR review/deployment handling and classifier nudges. Local additions retain relay batches, newest-relay expansion, cross-workspace context, action delivery feedback/logging, atomic sends, PR cache invalidation and closed-owner administration.

The old run-state status feature is intentionally removed, not kept as a compatibility shim. A load-time data migration removes stored `autoStatus` fields and reopens only automatically in-progress asks. Human-sent or explicitly in-progress asks keep their status; timestamps, outcomes and relay stamps are preserved.

## Backup proof

`git ls-remote --heads origin backup/local-main-2026-11 feat/asks-auto-status feat/relayed-asks fix/drop-notice-and-full-view fix/nudge-recorded-card fix/pin-plugin-paseo-min-version fix/refresh-covers-pill` returned:

```text
906104304a7645ce8f10cd3bc88c36c31381b48c refs/heads/backup/local-main-2026-11
4df7b7aaf99de495a3253a16c764d5379856265c refs/heads/feat/asks-auto-status
32fda006f5fe8e12febe653ceb25604498698659 refs/heads/feat/relayed-asks
9292fbf27fcba1be99610f0e9cdd8b1183aadd1f refs/heads/fix/drop-notice-and-full-view
03dba06d1ee8e2914e8c5a84323b244aa1f69b2a refs/heads/fix/nudge-recorded-card
a906c8e5ffd803f0210d93b7d3a782e10fecc74c refs/heads/fix/pin-plugin-paseo-min-version
176a8a156889edbf9b435547a4c7cf54479257ed refs/heads/fix/refresh-covers-pill
```

All seven original local heads match their backup refs exactly. The catch-up branch is an additional push, not a replacement for these backups.

## Verification

Dependencies installed with `bun install` in the root and preview. Generated Bun lockfiles were removed to retain the repository's existing package-lock convention.

- `bun run typecheck` exited 0: `$ tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.server.json`.
- The preview has no build script, but has a Vite production build. `bunx vite build` in `preview` exited 0: `✓ 2065 modules transformed.` and `✓ built in 342ms`.
- Vite warned that its 900.72 kB JavaScript chunk exceeds 500 kB; this is a warning, not a failed build.
- Full tests run through the machine-wide queue: `bun run --cwd /Users/wesleyfrederick/Documents/ObsidianVault/0_SoftwareDevelopment/cc-workflows-plugin test-queue exec --cwd /Users/wesleyfrederick/.paseo/plugin-src/paseo-asks-catch-up -- sh -c 'bun run test'`. A direct run was refused by the queue guard; the first queued attempt timed out before starting tests and was resubmitted without a deadline.
- The first completed suite found an integration mismatch: upstream's message-parser test marked an ask done and then dropped the same closed ask, which the preserved local closed-action guard correctly refuses. Done and dropped are now tested with independent fresh asks; neither parser assertion nor the refusal guard was weakened.
- Final full suite exited 0: `Test Files  20 passed (20)`, `Tests  246 passed (246)`, `Duration  2.17s`.
- Merge commit: `59d8335`. All 16 conflicted paths are resolved; no refresh-pill branch merge was performed.

## Activate or roll back

These commands are **[INFERENCE] — provided, not run**. They assume the live checkout is still clean and on main, as it was when work began. Nothing here updates fork main.

Activate by fast-forwarding the live main checkout, installing the updated SDK, and reloading only the plugin:

```bash
LIVE="$HOME/.paseo/plugin-src/paseo-asks"
git -C "$LIVE" merge --ff-only chore/catch-up-upstream
bun install --cwd "$LIVE" --no-save
paseo plugin reload paseo-asks
```

To return the live plugin to the exact pre-catch-up source without deleting changes or rewriting main, switch that checkout to a new rollback branch at its verified backup, reinstall its dependencies, and reload:

```bash
LIVE="$HOME/.paseo/plugin-src/paseo-asks"
git -C "$LIVE" switch -c rollback/asks-before-upstream-2026-11 origin/backup/local-main-2026-11
bun install --cwd "$LIVE" --no-save
paseo plugin reload paseo-asks
```

The rollback leaves main pointing at the catch-up and makes the live checkout run the backup branch. To activate again, switch the clean live checkout back to main, install and reload as above. Neither direction rolls back user answers or replaces the plugin data folder.

No live reload, daemon restart, browser exercise or separate `e2e` cassette replay was run for this catch-up; those behaviors are **[INFERENCE]**, not verified UI claims.
