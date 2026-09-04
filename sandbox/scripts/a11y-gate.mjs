import assert from "node:assert/strict";

const wcagConformanceTags = new Set([
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
]);

export function assertNoA11yViolations(violations, state = "page") {
  assert.ok(Array.isArray(violations), `${state}: axe violations must be an array`);
  const blocking = violations.filter((finding) => {
    const tags = Array.isArray(finding?.tags) ? finding.tags : [];
    return ["serious", "critical"].includes(finding?.impact)
      || tags.some((tag) => wcagConformanceTags.has(tag));
  });
  const summary = blocking.map((finding) => ({
    id: finding?.id || "unknown",
    impact: finding?.impact || "unknown",
    tags: Array.isArray(finding?.tags) ? finding.tags : [],
    targets: Array.isArray(finding?.targets) ? finding.targets : [],
    failure_summaries: Array.isArray(finding?.failure_summaries) ? finding.failure_summaries : [],
  }));
  assert.deepEqual(summary, [], `${state}: axe found serious/critical or WCAG A/AA violations`);
}
