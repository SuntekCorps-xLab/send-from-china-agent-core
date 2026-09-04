import assert from "node:assert/strict";
import test from "node:test";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

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
    /after-all-clicks: axe found serious\/critical or WCAG A\/AA violations/,
  );
});

test("browser QA also rejects lower-impact WCAG violations", () => {
  assert.throws(
    () => assertNoA11yViolations([{
      id: "landmark-one-main",
      impact: "moderate",
      tags: ["wcag2a"],
      targets: [["html"]],
    }], "initial"),
    assert.AssertionError,
  );
});

test("browser QA ignores only non-WCAG best-practice findings below serious impact", () => {
  assert.doesNotThrow(() => assertNoA11yViolations([{
    id: "region",
    impact: "moderate",
    tags: ["best-practice"],
    targets: [["main"]],
  }], "initial"));
});

test("real browser runner exits nonzero and writes a failed report for a serious best-practice finding", {
  skip: process.env.AGENT_CORE_A11Y_GATE_E2E !== "1",
}, async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "agent-core-a11y-negative-"));
  try {
    const result = spawnSync(process.execPath, [resolve("sandbox/scripts/browser-qa.mjs")], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        AGENT_CORE_SANDBOX_QA_BROWSERS: "chrome",
        AGENT_CORE_SANDBOX_QA_ARTIFACT_ROOT: artifactRoot,
        AGENT_CORE_SANDBOX_QA_TEST_FIXTURE: "unnamed-dialog",
      },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(await readFile(join(artifactRoot, "report.json"), "utf8"));
    assert.equal(report.passed, false);
    assert.equal(report.test_fixture, "unnamed-dialog");
    assert.ok(report.cases.some((entry) => entry.audits?.some((audit) =>
      audit.violations.some((finding) => finding.id === "aria-dialog-name" && finding.impact === "serious"))));
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("browser QA rejects malformed Axe output", () => {
  assert.throws(
    () => assertNoA11yViolations(null, "initial"),
    /initial: axe violations must be an array/,
  );
});
