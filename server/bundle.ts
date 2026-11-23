/**
 * Detects an ask whose title explicitly bundles several questions. Bodies may list questions for someone else (a
 * seller, a PR's reviewers), and generic approval or chat labels do not establish multiplicity.
 * Patterns come from real bundles in the asks data; see test/bundle.test.ts.
 */
const BUNDLED_TITLE = [
  // "Answer the 7 open questions", "Review spec #590 (11 open questions)", "Sign off 10 decisions". A bare "4
  // questions" may be questions for someone else ("ask the seller 4 questions first"), so it needs "answer".
  /\b\d+\s+(?:open|gate|owner|pending)\s+(?:questions|decisions)\b|\b\d+\s+decisions\b|\banswer\b.*\b\d+\s+questions\b/i,
  // "Answer Q1–Q7", "Sign off decisions D1–D10"
  /\b[QD]-?1\s*[–—-]\s*[QD]?-?\d+\b/i,
];

/** Why the ask is a bundle, or null when it is one item. */
export function bundleReason(title: string): string | null {
  if (BUNDLED_TITLE.some((pattern) => pattern.test(title))) return `the title "${title}" counts several questions`;
  return null;
}

export function checkNotBundled(title: string): void {
  const reason = bundleReason(title);
  if (!reason) return;
  throw new Error(
    `This ask bundles several questions: ${reason}. Create one ask per question instead, each with its own options and your proposal marked recommended; repeat the shared context in a line or two of each body. Nothing was saved.`,
  );
}
