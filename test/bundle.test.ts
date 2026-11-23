import { describe, expect, it } from "vitest";
import { bundleReason } from "../server/bundle";

// Titles must establish that the ask contains several questions. A generic approval or chat label is not evidence.
const BUNDLES = [
  "Answer Q1–Q7 for the identity spec",
  "Sign off SPEC-024 decisions D1–D10 (reset plan)?",
  "Answer the 8 gate questions for the attribute-system spec (#471)",
  "D3: answer spec #565's 4 open questions, then merge #565 and #568?",
  "Review spec #590: monitoring for queues and jobs (11 open questions)",
  "Answer the 7 open questions for the organization-scoped settings spec",
];

const SINGLES = [
  "Review spec PR #6: product structure",
  "Push the identity spec and open a PR?",
  "Review #116: upgrade notes per release",
  "Forward-undo spec: soft delete + restore (B), or delete not undoable (C)?",
  "Commit the 3 storyboard comments to PR #35's comments.js?",
  "Buy the account (ask the seller 4 questions first)",
  "Bundled asks: which mechanism do I build?",
  "Request review on PR #30",
  "Merge PR #30 when green",
  "Approve deploying 1.2.3 to production?",
  "Review the time & attendance spec",
  "Audit 2023–2025: facts before I compute the exposure",
  "Settings nav atlas ready: approve option F (or say what to change)?",
];

describe("bundleReason", () => {
  it.each(BUNDLES)("flags %s", (title) => {
    expect(bundleReason(title)).not.toBeNull();
  });
  it.each(SINGLES)("passes %s", (title) => {
    expect(bundleReason(title)).toBeNull();
  });
});
