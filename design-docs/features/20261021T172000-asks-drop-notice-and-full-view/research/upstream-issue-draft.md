# Paseo bug report draft: double popover (NOT published)

## How Paseo takes reports (read 2026-10-22, getpaseo/paseo origin/main)
- Issues are for bugs only, and only through the "Bug report" form; blank issues are off. Feature requests filed as issues are closed (CONTRIBUTING.md "Discuss workflows before proposing features"; .github/ISSUE_TEMPLATE/config.yml `blank_issues_enabled: false`).
- Required fields: What's broken, Steps to reproduce (say so if not reproducible on demand), Where (Desktop (Electron)), Paseo version. Title starts `bug: `.
- UI bugs: a screenshot or short video is **required**.
- AI-assisted reports: paste raw inputs (logs, data, repro steps). Do not submit an agent's diagnosis as the report; CONTRIBUTING: "Its explanation of the cause still needs verification."
- Before opening: search existing issues and try the latest version.
- PRs are "closed by default", so do not send a fix PR unasked.

## Pre-checks done
- Search: no existing issue for a duplicate popover or menu, or for the workspace screen mounted twice. Queries: "popover twice", "duplicate popover", "menu top left", "plugin popover", "workspace screen twice", "rendered twice", "menu opens twice", "dropdown opens twice", "popover top left corner". Nearest unrelated: #5049 (reply rendered twice).
- Latest version: we run v0.12.0 (latest stable). v0.13.0-beta.1 changes only an import line in the workspace route file; nothing in the menu or popover code.

## Gaps before this meets the bar (only Wesley can fill)
1. **Screenshot or short video** of one click showing the popover twice (at the pill and at the top-left). Required for UI bugs.
2. **What you did before it appeared**, if you recall (for example, switched workspaces several times, or started agents with "new"). If unknown, the report says it is not reproducible on demand.
3. Optional and strengthening: does a built-in Paseo menu (not a plugin pill) also appear twice? If yes, the report is clearly about core; if only the plugin pill does, the maintainer may treat it as plugin-specific.

---

## Draft (form fields)

**Title:** `bug: one click on a composer pill opens its popover twice; the second copy appears at the top-left of the window`

**What's broken**
I clicked the "Asks" composer pill (from the paseo-asks plugin; the popover frame is the host's plugin popover). Expected: one popover anchored to the pill. Got: the popover anchored at the pill, plus a second copy at the top-left corner of the window.

**Steps to reproduce**
Not reproducible on demand yet. Observed on a desktop window open for several hours with ~10 workspaces, after switching between workspaces. <!-- fill from gap 2 -->
1. Open a workspace that has a composer pill with a popover.
2. Click the pill.

**Where did this happen:** Desktop (Electron)
**Paseo version:** 0.12.0
**OS version:** macOS 15.6 (Darwin 24.6.0), Apple silicon
**Agent provider:** Not relevant

**Logs** (raw data collected by a one-time probe in the plugin, which listed every mounted instance of the pill; full JSON attached)
```text
mounted pill instances: 20 (10 workspaces x 2); on screen: 1 at x=342 y=894; the other 19 measure 0,0,0,0
current workspace wks_82129821112f13d3 has 2 instances:
  route key index-QvyfjJkc9g2d1rMBFR7kP   rect visible   active=true isRouteFocused=true
  route key index-V_Xqq2gpq-_RmzsEWkkq_   rect 0,0,0,0   active=true isRouteFocused=true
same pill entry (key 342, id asks), same agent, same deck entry; only the route key differs
```

**Screenshots or video:** <!-- gap 1: required -->

**Note (unverified, for context only):** the data suggests the stack holds two instances of the `workspace/[workspaceId]` route, and both report themselves active. The hidden instance's menu then opens at its 0,0 anchor. The comment in `navigation/workspace-route-navigation.ts` about `/new` → workspace hops appending hidden deck entries may be related.
