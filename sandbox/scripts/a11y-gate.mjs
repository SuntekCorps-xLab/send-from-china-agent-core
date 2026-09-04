import assert from "node:assert/strict";

export function assertNoA11yViolations(violations, state = "page") {
  assert.ok(Array.isArray(violations), `${state}: axe violations must be an array`);
  const summary = violations.map((finding) => ({
    id: finding?.id || "unknown",
    impact: finding?.impact || "unknown",
    targets: Array.isArray(finding?.targets) ? finding.targets : [],
    failure_summaries: Array.isArray(finding?.failure_summaries) ? finding.failure_summaries : [],
  }));
  assert.deepEqual(summary, [], `${state}: axe found WCAG A/AA violations`);
}
