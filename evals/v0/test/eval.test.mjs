import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PRIVATE_LIVE_GATES, validateDataset } from "../dataset.mjs";
import { requirePublicSyntheticDataset } from "../run.mjs";
import { scoreCase, scoreSuite } from "../scorer.mjs";

const evalDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(evalDirectory, "..", "..");

function caseFixture() {
  return {
    case_id: "scorer-unit",
    suites: ["full"],
    request: {
      hard_constraints: [
        { name: "price_max", value: 20 },
        { name: "exclude", value: "polyester" },
      ],
    },
    expected: {
      status: "results",
      relevance: [
        { public_id: "A1b2C3d4E5f6G7h8J9k0Lm", grade: 3 },
        { public_id: "B2c3D4e5F6g7H8j9K0m1Np", grade: 1 },
      ],
      forbidden_ids: ["C3d4E5f6G7h8J9k0L1m2Pq"],
    },
  };
}

test("the versioned public dataset is synthetic and has meaningful suite coverage", async () => {
  const dataset = validateDataset(JSON.parse(await readFile(resolve(evalDirectory, "dataset.json"), "utf8")));
  assert.equal(dataset.provenance, "public_synthetic");
  assert.ok(dataset.cases.length >= 20);
  assert.ok(dataset.cases.filter((entry) => entry.suites.includes("smoke")).length >= 8);
  assert.ok(dataset.cases.filter((entry) => entry.suites.includes("security")).length >= 6);
  assert.ok(dataset.cases.some((entry) => entry.expected.status === "no_match"));
  assert.ok(dataset.cases.some((entry) => entry.expected.forbidden_ids.length > 0));
  assert.ok(dataset.cases.some((entry) => entry.request.hard_constraints.length > 1));
});

test("the public runner refuses a valid private_live dataset before execution", async () => {
  const dataset = JSON.parse(await readFile(resolve(evalDirectory, "dataset.json"), "utf8"));
  dataset.provenance = "private_live";
  dataset.dataset_version = "private-runner-refusal-v1";
  dataset.catalog_fixture = `private-snapshot:${"a".repeat(64)}`;
  dataset.gates = { ...PRIVATE_LIVE_GATES };
  assert.equal(validateDataset(dataset), dataset);
  assert.throws(() => requirePublicSyntheticDataset(dataset), /only public_synthetic/);
});

test("the scorer computes ranking metrics and catches forbidden and hard-constraint violations", () => {
  const fixture = caseFixture();
  const good = scoreCase(fixture, {
    status: "results",
    results: [
      { public_id: "A1b2C3d4E5f6G7h8J9k0Lm", price: { amount: 18 }, title: "Bamboo tray" },
      { public_id: "B2c3D4e5F6g7H8j9K0m1Np", price: { amount: 19 }, title: "Steel tray" },
    ],
  });
  assert.equal(good.metrics.recall_at_20, 1);
  assert.equal(good.metrics.recall_at_50, 1);
  assert.equal(good.metrics.precision_at_10, 1);
  assert.equal(good.metrics.ndcg_at_10, 1);
  assert.equal(good.passed, true);

  const bad = scoreCase(fixture, {
    status: "degraded",
    results: [
      { public_id: "C3d4E5f6G7h8J9k0L1m2Pq", price: { amount: 25 }, title: "Polyester tray" },
      { public_id: "C3d4E5f6G7h8J9k0L1m2Pq", price: { amount: 25 }, title: "Polyester tray" },
    ],
  });
  assert.equal(bad.metrics.status_match, false);
  assert.deepEqual(bad.violations.forbidden_ids, ["C3d4E5f6G7h8J9k0L1m2Pq"]);
  assert.equal(bad.violations.hard_constraints.length, 4);
  assert.deepEqual(bad.violations.duplicate_ids, ["C3d4E5f6G7h8J9k0L1m2Pq"]);
  assert.equal(bad.passed, false);
});

test("suite gates fail closed when aggregate quality or safety evidence is missing", () => {
  const fixture = caseFixture();
  const gates = {
    minimum_recall_at_20: 1,
    minimum_recall_at_50: 1,
    minimum_precision_at_10: 0.85,
    minimum_ndcg_at_10: 1,
    minimum_status_accuracy: 1,
    maximum_forbidden_id_hits: 0,
    maximum_hard_constraint_violations: 0,
    maximum_duplicate_id_hits: 0,
  };
  const predictions = new Map([[fixture.case_id, { status: "no_match", results: [] }]]);
  const scored = scoreSuite([fixture], predictions, gates);
  assert.equal(scored.passed, false);
  assert.equal(scored.gate_checks.recall_at_50, false);
  assert.equal(scored.gate_checks.status_accuracy, false);
});

test("the smoke runner emits sanitized exact-commit evidence", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-core-eval-v0-"));
  const output = join(temporary, "smoke.json");
  try {
    const result = spawnSync(process.execPath, [resolve(evalDirectory, "run.mjs"), "--suite", "smoke", "--output", output], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const artifact = JSON.parse(await readFile(output, "utf8"));
    assert.match(artifact.repository.commit, /^[0-9a-f]{40}$/u);
    assert.match(artifact.dataset.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(artifact.provenance, "public_synthetic");
    assert.equal(artifact.production_relevance_claim, false);
    assert.equal(artifact.execution.external_network_requests, 0);
    assert.equal(artifact.gates.passed, true);
    const serialized = JSON.stringify(artifact);
    assert.equal(serialized.includes("desk organizer"), false);
    assert.equal(serialized.includes("public_eval_synthetic_scope"), false);
    assert.equal(serialized.includes("Authorization"), false);
    assert.equal(serialized.includes("product_identity"), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
