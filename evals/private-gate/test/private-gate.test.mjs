import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CORE_CASE_COUNT,
  HOLDOUT_CASE_COUNT,
  MINIMUM_KAPPA,
  PROVISIONAL_CASE_COUNT,
  buildPrivateEvalGate,
  runCli,
} from "../adjudicate.mjs";
import { PRIVATE_LIVE_GATES, validateDataset } from "../../v0/dataset.mjs";

function publicId(prefix, index) {
  return `${prefix}${String(index).padStart(21, "0")}`;
}

function dataset(count, version, prefix, offset = 0) {
  return {
    dataset_version: version,
    schema_version: "send-from-china-eval-dataset/v0",
    provenance: "private_live",
    generated_at: "2026-08-27T00:00:00.000Z",
    catalog_fixture: `private-snapshot:${"a".repeat(64)}`,
    description: "Synthetic test object for the private Eval contract; not production data.",
    limitations: [
      "Test-only generated labels are not production relevance evidence.",
      "The private Gate still requires two real independent reviewers.",
    ],
    gates: { ...PRIVATE_LIVE_GATES },
    cases: Array.from({ length: count }, (_, position) => {
      const index = position + offset;
      const suites = ["full"];
      if (position < 8) suites.push("smoke");
      if (position === 0) suites.push("security");
      return {
        case_id: `${prefix}_case_${String(index).padStart(3, "0")}`,
        suites,
        request: {
          contract_version: "2.0",
          product_identity: {
            name: "product_identity",
            value: `synthetic evaluation query ${index}`,
            source: "explicit",
            scope: "product",
            hardness: "hard",
          },
          hard_constraints: position === 0 ? [{
            name: "price_max",
            value: 40,
            source: "explicit",
            scope: "product",
            hardness: "hard",
          }] : [],
          soft_context: [],
          transaction_context: [],
          limit: 50,
          cursor: null,
        },
        expected: {
          status: "results",
          relevance: [{ public_id: publicId("P", index), grade: 3 }],
          forbidden_ids: [],
        },
      };
    }),
  };
}

function review(gold, reviewer, mutate) {
  return {
    schema_version: "send-from-china-eval-review/v1",
    dataset_version: gold.dataset_version,
    reviewer_id_hash: reviewer.repeat(64),
    cases: gold.cases.map((entry, index) => {
      const relevant = entry.expected.relevance[0].public_id;
      const decoy = publicId("D", index);
      const row = {
        case_id: entry.case_id,
        status: "results",
        candidates: [
          { public_id: relevant, grade: 3 },
          { public_id: decoy, grade: 0 },
        ],
        forbidden_ids: [],
      };
      mutate?.(row, index);
      return row;
    }),
  };
}

function fixture() {
  const coreDataset = dataset(CORE_CASE_COUNT, "private-core-v1", "private");
  const provisionalDataset = dataset(PROVISIONAL_CASE_COUNT, "private-provisional-v1", "provisional", 1000);
  return {
    coreDataset,
    provisionalDataset,
    holdout: {
      schema_version: "send-from-china-eval-holdout/v1",
      dataset_version: coreDataset.dataset_version,
      case_ids: coreDataset.cases.slice(0, HOLDOUT_CASE_COUNT).map((entry) => entry.case_id),
    },
    reviewerA: review(coreDataset, "a"),
    reviewerB: review(coreDataset, "b"),
  };
}

test("the shared dataset contract accepts private inputs only with locked live thresholds", () => {
  const value = fixture().coreDataset;
  assert.equal(validateDataset(value), value);
  value.gates.minimum_recall_at_20 = 0.89;
  assert.throws(() => validateDataset(value), /cannot change/);
});

test("two independent matching reviews pass the 120/30/180 aggregate Gate", () => {
  const inputs = fixture();
  const artifact = buildPrivateEvalGate(inputs);
  assert.equal(artifact.gate.passed, true);
  assert.equal(artifact.gate.minimum_kappa, MINIMUM_KAPPA);
  assert.equal(artifact.agreement.gate_kappa, 1);
  assert.deepEqual(artifact.datasets, {
    core_sha256: artifact.datasets.core_sha256,
    provisional_sha256: artifact.datasets.provisional_sha256,
    holdout_assignment_sha256: artifact.datasets.holdout_assignment_sha256,
    core_case_count: 120,
    training_case_count: 90,
    hidden_holdout_case_count: 30,
    provisional_case_count: 180,
  });
  assert.equal(artifact.boundaries.authorizes_search_rollout, false);

  const serialized = JSON.stringify(artifact);
  for (const forbidden of [
    inputs.coreDataset.cases[0].case_id,
    inputs.coreDataset.cases[0].request.product_identity.value,
    inputs.coreDataset.cases[0].expected.relevance[0].public_id,
    inputs.reviewerA.reviewer_id_hash,
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("low reviewer agreement blocks even when the final labels choose reviewer A", () => {
  const inputs = fixture();
  inputs.reviewerB = review(inputs.coreDataset, "b", (row) => {
    row.candidates[0].grade = 0;
    row.candidates[1].grade = 3;
  });
  const artifact = buildPrivateEvalGate(inputs);
  assert.ok(artifact.agreement.relevance_quadratic_weighted_kappa < MINIMUM_KAPPA);
  assert.equal(artifact.gate.passed, false);
});

test("an adjudicated label unsupported by either reviewer fails closed", () => {
  const inputs = fixture();
  inputs.coreDataset.cases[0].expected.relevance[0].grade = 2;
  const artifact = buildPrivateEvalGate(inputs);
  assert.equal(artifact.adjudication.unsupported_decision_count, 1);
  assert.equal(artifact.gate.passed, false);
});

test("case counts, holdout membership, overlap and candidate universes are immutable", () => {
  const tooSmall = fixture();
  tooSmall.coreDataset.cases.pop();
  assert.throws(() => buildPrivateEvalGate(tooSmall), /exactly 120/);

  const invalidHoldout = fixture();
  invalidHoldout.holdout.case_ids[0] = "outside_case_999";
  assert.throws(() => buildPrivateEvalGate(invalidHoldout), /outside the core/);

  const overlap = fixture();
  overlap.provisionalDataset.cases[0].case_id = overlap.coreDataset.cases[0].case_id;
  assert.throws(() => buildPrivateEvalGate(overlap), /must not overlap/);

  const differentUniverse = fixture();
  differentUniverse.reviewerB.cases[0].candidates[1].public_id = publicId("X", 0);
  assert.throws(() => buildPrivateEvalGate(differentUniverse), /same candidate universe/);

  const relevantForbidden = fixture();
  relevantForbidden.reviewerB.cases[0].forbidden_ids = [
    relevantForbidden.reviewerB.cases[0].candidates[0].public_id,
  ];
  assert.throws(() => buildPrivateEvalGate(relevantForbidden), /cannot be relevant/);
});

test("all private Gate JSON Schemas are machine-readable and lock public-safe output", async () => {
  for (const file of ["review.schema.json", "holdout.schema.json", "artifact.schema.json"]) {
    const schema = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
    assert.equal(schema.additionalProperties, false);
  }
  const artifactSchema = JSON.parse(await readFile(new URL("../artifact.schema.json", import.meta.url), "utf8"));
  assert.equal(artifactSchema.properties.gate.properties.minimum_kappa.const, 0.8);
  assert.equal(artifactSchema.properties.boundaries.properties.contains_queries.const, false);
  assert.equal(artifactSchema.properties.boundaries.properties.authorizes_search_rollout.const, false);
});

test("the CLI writes only a sanitized ignored artifact", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "private-eval-gate-"));
  try {
    const inputs = fixture();
    const files = {};
    for (const [name, value] of Object.entries(inputs)) {
      files[name] = path.join(directory, `${name}.json`);
      await writeFile(files[name], JSON.stringify(value), "utf8");
    }
    const output = path.join(directory, "artifact.json");
    const artifact = await runCli([
      "--core", files.coreDataset,
      "--provisional", files.provisionalDataset,
      "--holdout", files.holdout,
      "--reviewer-a", files.reviewerA,
      "--reviewer-b", files.reviewerB,
      "--output", output,
    ]);
    assert.equal(artifact.gate.passed, true);
    const serialized = await readFile(output, "utf8");
    assert.equal(serialized.includes(inputs.coreDataset.cases[0].case_id), false);
    assert.equal(serialized.includes(inputs.coreDataset.cases[0].request.product_identity.value), false);
    assert.equal(serialized.includes(inputs.reviewerA.reviewer_id_hash), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the CLI refuses private inputs placed under the repository", async () => {
  const checkedIn = fileURLToPath(new URL("../../v0/dataset.json", import.meta.url));
  await assert.rejects(runCli([
    "--core", checkedIn,
    "--provisional", checkedIn,
    "--holdout", checkedIn,
    "--reviewer-a", checkedIn,
    "--reviewer-b", checkedIn,
    "--output", fileURLToPath(new URL("../../../build/private-eval-gate/test.json", import.meta.url)),
  ]), /outside the repository/);
});
