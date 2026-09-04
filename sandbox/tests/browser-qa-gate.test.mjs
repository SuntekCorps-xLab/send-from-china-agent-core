import assert from "node:assert/strict";
import test from "node:test";

import { assertNoA11yViolations } from "../scripts/a11y-gate.mjs";

test("browser QA accepts an empty Axe result", () => {
  assert.doesNotThrow(() => assertNoA11yViolations([], "initial"));
});

test("browser QA fails closed on a serious Axe result", () => {
  assert.throws(
    () => assertNoA11yViolations([{
      id: "color-contrast",
      impact: "serious",
      targets: [[".primary-action"]],
    }], "after-all-clicks"),
    /after-all-clicks: axe found WCAG A\/AA violations/,
  );
});

test("browser QA also rejects lower-impact WCAG violations", () => {
  assert.throws(
    () => assertNoA11yViolations([{
      id: "landmark-one-main",
      impact: "moderate",
      targets: [["html"]],
    }], "initial"),
    assert.AssertionError,
  );
});

test("browser QA rejects malformed Axe output", () => {
  assert.throws(
    () => assertNoA11yViolations(null, "initial"),
    /initial: axe violations must be an array/,
  );
});
