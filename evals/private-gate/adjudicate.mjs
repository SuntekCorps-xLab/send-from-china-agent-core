import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PRIVATE_LIVE_GATES, validateDataset } from "../v0/dataset.mjs";

export const CORE_CASE_COUNT = 120;
export const HOLDOUT_CASE_COUNT = 30;
export const PROVISIONAL_CASE_COUNT = 180;
export const MINIMUM_KAPPA = 0.8;

const ARTIFACT_SCHEMA = "send-from-china-private-eval-gate/v1";
const REVIEW_SCHEMA = "send-from-china-eval-review/v1";
const HOLDOUT_SCHEMA = "send-from-china-eval-holdout/v1";
const RUNNER_VERSION = "private-eval-agreement-v1.1.0";
const STATUS_VALUES = ["results", "needs_clarification", "no_match", "degraded"];
const CASE_ID = /^[a-z0-9][a-z0-9_-]{2,80}$/u;
const PUBLIC_ID = /^[A-Za-z0-9]{22}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function invariant(condition, message) {
  if (!condition) throw new TypeError(message);
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

const RUNNER_SOURCE_SHA256 = digest(readFileSync(fileURLToPath(import.meta.url), "utf8"));

function validatePrivateDataset(dataset, expectedCount, label) {
  validateDataset(dataset);
  invariant(dataset.provenance === "private_live", `${label} must use private_live provenance`);
  invariant(dataset.cases.length === expectedCount, `${label} must contain exactly ${expectedCount} cases`);
  for (const [field, expected] of Object.entries(PRIVATE_LIVE_GATES)) {
    invariant(dataset.gates[field] === expected, `${label} cannot change ${field}`);
  }
  return dataset;
}

export function validateReview(review, dataset) {
  invariant(exactKeys(review, new Set([
    "schema_version", "dataset_version", "reviewer_id_hash", "cases",
  ])), "review has unsupported fields");
  invariant(review.schema_version === REVIEW_SCHEMA, "review schema is unsupported");
  invariant(review.dataset_version === dataset.dataset_version, "review dataset version does not match");
  invariant(SHA256.test(review.reviewer_id_hash), "reviewer identity must be a one-way SHA-256 value");
  invariant(Array.isArray(review.cases) && review.cases.length === dataset.cases.length, "review case count does not match");

  const expectedCases = new Set(dataset.cases.map((entry) => entry.case_id));
  const seenCases = new Set();
  for (const entry of review.cases) {
    invariant(exactKeys(entry, new Set(["case_id", "status", "candidates", "forbidden_ids"])), "review case has unsupported fields");
    invariant(CASE_ID.test(entry.case_id) && expectedCases.has(entry.case_id) && !seenCases.has(entry.case_id), "review case identity is invalid");
    invariant(STATUS_VALUES.includes(entry.status), "review status is invalid");
    invariant(Array.isArray(entry.candidates) && entry.candidates.length > 0 && entry.candidates.length <= 500, "review candidate set is invalid");
    const candidateIds = new Set();
    for (const candidate of entry.candidates) {
      invariant(exactKeys(candidate, new Set(["public_id", "grade"])), "review candidate has unsupported fields");
      invariant(PUBLIC_ID.test(candidate.public_id) && !candidateIds.has(candidate.public_id), "review candidate identity is invalid");
      invariant(Number.isInteger(candidate.grade) && candidate.grade >= 0 && candidate.grade <= 3, "review grade is invalid");
      candidateIds.add(candidate.public_id);
    }
    invariant((entry.status === "results") === entry.candidates.some((candidate) => candidate.grade > 0), "review status and relevance grades disagree");
    invariant(Array.isArray(entry.forbidden_ids) && entry.forbidden_ids.length === new Set(entry.forbidden_ids).size, "review forbidden IDs must be unique");
    invariant(entry.forbidden_ids.every((id) => PUBLIC_ID.test(id) && candidateIds.has(id)), "review forbidden ID is outside the candidate set");
    invariant(entry.forbidden_ids.every((id) => entry.candidates.find((candidate) => candidate.public_id === id)?.grade === 0), "review forbidden ID cannot be relevant");
    seenCases.add(entry.case_id);
  }
  invariant(seenCases.size === expectedCases.size, "review is missing a dataset case");
  return review;
}

export function validateHoldout(holdout, dataset) {
  invariant(exactKeys(holdout, new Set(["schema_version", "dataset_version", "case_ids"])), "holdout has unsupported fields");
  invariant(holdout.schema_version === HOLDOUT_SCHEMA, "holdout schema is unsupported");
  invariant(holdout.dataset_version === dataset.dataset_version, "holdout dataset version does not match");
  invariant(Array.isArray(holdout.case_ids) && holdout.case_ids.length === HOLDOUT_CASE_COUNT, `holdout must contain exactly ${HOLDOUT_CASE_COUNT} cases`);
  invariant(new Set(holdout.case_ids).size === HOLDOUT_CASE_COUNT, "holdout case IDs must be unique");
  const coreIds = new Set(dataset.cases.map((entry) => entry.case_id));
  invariant(holdout.case_ids.every((id) => CASE_ID.test(id) && coreIds.has(id)), "holdout contains a case outside the core dataset");
  return holdout;
}

function caseMap(review) {
  return new Map(review.cases.map((entry) => [entry.case_id, entry]));
}

function candidateMap(entry) {
  return new Map(entry.candidates.map((candidate) => [candidate.public_id, candidate.grade]));
}

function sameKeys(left, right) {
  return left.size === right.size && [...left.keys()].every((key) => right.has(key));
}

function unweightedKappa(left, right, categories) {
  invariant(left.length === right.length && left.length > 0, "kappa label vectors are invalid");
  invariant(new Set(left).size > 1 && new Set(right).size > 1, "unweighted kappa requires label variance from both reviewers");
  const observed = left.reduce((count, value, index) => count + Number(value === right[index]), 0) / left.length;
  let expected = 0;
  for (const category of categories) {
    const leftShare = left.filter((value) => value === category).length / left.length;
    const rightShare = right.filter((value) => value === category).length / right.length;
    expected += leftShare * rightShare;
  }
  invariant(expected !== 1, "unweighted kappa is undefined for degenerate labels");
  return Number(((observed - expected) / (1 - expected)).toFixed(6));
}

function quadraticWeightedKappa(left, right) {
  invariant(left.length === right.length && left.length > 0, "weighted kappa label vectors are invalid");
  invariant(new Set(left).size > 1 && new Set(right).size > 1, "weighted kappa requires label variance from both reviewers");
  const categories = [0, 1, 2, 3];
  const maximumDistance = (categories.length - 1) ** 2;
  let observedDisagreement = 0;
  for (let index = 0; index < left.length; index += 1) {
    observedDisagreement += ((left[index] - right[index]) ** 2) / maximumDistance;
  }
  observedDisagreement /= left.length;

  let expectedDisagreement = 0;
  for (const leftCategory of categories) {
    const leftShare = left.filter((value) => value === leftCategory).length / left.length;
    for (const rightCategory of categories) {
      const rightShare = right.filter((value) => value === rightCategory).length / right.length;
      expectedDisagreement += leftShare * rightShare * (((leftCategory - rightCategory) ** 2) / maximumDistance);
    }
  }
  invariant(expectedDisagreement !== 0, "weighted kappa is undefined for degenerate labels");
  return Number((1 - (observedDisagreement / expectedDisagreement)).toFixed(6));
}

function validateReviewPair(left, right) {
  invariant(left.reviewer_id_hash !== right.reviewer_id_hash, "reviews must come from two distinct reviewers");
  const leftCases = caseMap(left);
  const rightCases = caseMap(right);
  invariant(sameKeys(leftCases, rightCases), "reviewers did not label the same cases");
  for (const [caseId, leftCase] of leftCases) {
    const rightCase = rightCases.get(caseId);
    invariant(sameKeys(candidateMap(leftCase), candidateMap(rightCase)), "reviewers did not label the same candidate universe");
  }
  return { leftCases, rightCases };
}

function goldResolution(dataset, leftCases, rightCases) {
  let unsupported = 0;
  let adjudicatedStatus = 0;
  let adjudicatedRelevance = 0;
  let adjudicatedForbidden = 0;
  for (const goldCase of dataset.cases) {
    const left = leftCases.get(goldCase.case_id);
    const right = rightCases.get(goldCase.case_id);
    if (left.status !== right.status) adjudicatedStatus += 1;
    if (![left.status, right.status].includes(goldCase.expected.status)) unsupported += 1;

    const leftGrades = candidateMap(left);
    const rightGrades = candidateMap(right);
    const goldGrades = new Map(goldCase.expected.relevance.map((entry) => [entry.public_id, entry.grade]));
    if ([...goldGrades.keys()].some((id) => !leftGrades.has(id))) unsupported += 1;
    for (const [id, leftGrade] of leftGrades) {
      const rightGrade = rightGrades.get(id);
      const goldGrade = goldGrades.get(id) || 0;
      if (leftGrade !== rightGrade) adjudicatedRelevance += 1;
      if (goldGrade !== leftGrade && goldGrade !== rightGrade) unsupported += 1;

      const leftForbidden = left.forbidden_ids.includes(id);
      const rightForbidden = right.forbidden_ids.includes(id);
      const goldForbidden = goldCase.expected.forbidden_ids.includes(id);
      if (leftForbidden !== rightForbidden) adjudicatedForbidden += 1;
      if (goldForbidden !== leftForbidden && goldForbidden !== rightForbidden) unsupported += 1;
    }
    if (goldCase.expected.forbidden_ids.some((id) => !leftGrades.has(id))) unsupported += 1;
  }
  return { unsupported, adjudicatedStatus, adjudicatedRelevance, adjudicatedForbidden };
}

export function candidateUniverseFingerprint(cases) {
  return digest([...cases.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([caseId, entry]) => ({
      case_id: caseId,
      candidate_ids: [...candidateMap(entry).keys()].sort(),
    })));
}

export function buildPrivateEvalGate({ coreDataset, provisionalDataset, holdout, reviewerA, reviewerB, repository }) {
  invariant(exactKeys(repository, new Set(["commit", "working_tree_dirty"])), "exact repository evidence is required");
  invariant(/^[0-9a-f]{40}$/u.test(repository.commit), "repository commit must be an exact SHA");
  invariant(typeof repository.working_tree_dirty === "boolean", "repository dirty state is invalid");
  validatePrivateDataset(coreDataset, CORE_CASE_COUNT, "core dataset");
  validatePrivateDataset(provisionalDataset, PROVISIONAL_CASE_COUNT, "provisional dataset");
  invariant(coreDataset.dataset_version !== provisionalDataset.dataset_version, "core and provisional dataset versions must differ");
  const coreIds = new Set(coreDataset.cases.map((entry) => entry.case_id));
  invariant(provisionalDataset.cases.every((entry) => !coreIds.has(entry.case_id)), "provisional cases must not overlap the core dataset");
  validateHoldout(holdout, coreDataset);
  validateReview(reviewerA, coreDataset);
  validateReview(reviewerB, coreDataset);
  const { leftCases, rightCases } = validateReviewPair(reviewerA, reviewerB);

  const statusesA = [];
  const statusesB = [];
  const gradesA = [];
  const gradesB = [];
  const forbiddenA = [];
  const forbiddenB = [];
  let statusDisagreements = 0;
  let relevanceDisagreements = 0;
  let forbiddenDisagreements = 0;
  for (const caseId of [...coreIds].sort()) {
    const left = leftCases.get(caseId);
    const right = rightCases.get(caseId);
    statusesA.push(left.status);
    statusesB.push(right.status);
    statusDisagreements += Number(left.status !== right.status);
    const leftGrades = candidateMap(left);
    const rightGrades = candidateMap(right);
    for (const id of [...leftGrades.keys()].sort()) {
      gradesA.push(leftGrades.get(id));
      gradesB.push(rightGrades.get(id));
      relevanceDisagreements += Number(leftGrades.get(id) !== rightGrades.get(id));
      const leftForbidden = left.forbidden_ids.includes(id);
      const rightForbidden = right.forbidden_ids.includes(id);
      forbiddenA.push(leftForbidden);
      forbiddenB.push(rightForbidden);
      forbiddenDisagreements += Number(leftForbidden !== rightForbidden);
    }
  }

  const agreement = {
    status_kappa: unweightedKappa(statusesA, statusesB, STATUS_VALUES),
    relevance_quadratic_weighted_kappa: quadraticWeightedKappa(gradesA, gradesB),
    forbidden_binary_kappa: unweightedKappa(forbiddenA, forbiddenB, [false, true]),
    status_disagreement_count: statusDisagreements,
    relevance_disagreement_count: relevanceDisagreements,
    forbidden_disagreement_count: forbiddenDisagreements,
  };
  agreement.gate_kappa = Number(Math.min(
    agreement.status_kappa,
    agreement.relevance_quadratic_weighted_kappa,
    agreement.forbidden_binary_kappa,
  ).toFixed(6));

  const resolution = goldResolution(coreDataset, leftCases, rightCases);
  const passed = agreement.gate_kappa >= MINIMUM_KAPPA
    && resolution.unsupported === 0
    && repository.working_tree_dirty === false;
  return {
    schema_version: ARTIFACT_SCHEMA,
    generated_at: new Date().toISOString(),
    provenance: "private_live_aggregate_only",
    runner: {
      version: RUNNER_VERSION,
      source_sha256: RUNNER_SOURCE_SHA256,
    },
    repository,
    input_fingerprint_sha256: digest({ coreDataset, provisionalDataset, holdout, reviewerA, reviewerB }),
    datasets: {
      core_sha256: digest(coreDataset),
      provisional_sha256: digest(provisionalDataset),
      holdout_assignment_sha256: digest(holdout),
      core_case_count: CORE_CASE_COUNT,
      training_case_count: CORE_CASE_COUNT - HOLDOUT_CASE_COUNT,
      hidden_holdout_case_count: HOLDOUT_CASE_COUNT,
      provisional_case_count: PROVISIONAL_CASE_COUNT,
      candidate_universe_sha256: candidateUniverseFingerprint(leftCases),
    },
    agreement,
    adjudication: {
      unsupported_decision_count: resolution.unsupported,
      resolved_status_disagreement_count: resolution.adjudicatedStatus,
      resolved_relevance_disagreement_count: resolution.adjudicatedRelevance,
      resolved_forbidden_disagreement_count: resolution.adjudicatedForbidden,
    },
    annotation_agreement_gate: {
      minimum_kappa: MINIMUM_KAPPA,
      labeling_rules_locked: true,
      passed,
    },
    boundaries: {
      contains_case_ids: false,
      contains_queries: false,
      contains_product_ids: false,
      contains_reviewer_identity: false,
      evaluates_retrieval_quality: false,
      scores_hidden_holdout: false,
      scores_provisional_regression: false,
      authorizes_search_rollout: false,
    },
  };
}

function argument(args, name) {
  const index = args.indexOf(name);
  invariant(index >= 0 && args[index + 1] && !args[index + 1].startsWith("--"), `${name} is required`);
  return args[index + 1];
}

async function readJson(file) {
  return JSON.parse(await readFile(path.resolve(file), "utf8"));
}

function gitOutput(args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8", shell: false });
  invariant(result.status === 0, "exact Git metadata is required");
  return result.stdout.trim();
}

function repositoryEvidence() {
  return {
    commit: gitOutput(["rev-parse", "HEAD"]),
    working_tree_dirty: gitOutput(["status", "--porcelain", "--untracked-files=normal"]).length > 0,
  };
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function runCli(args = process.argv.slice(2), options = {}) {
  const output = path.resolve(argument(args, "--output"));
  const inputs = {
    core: path.resolve(argument(args, "--core")),
    provisional: path.resolve(argument(args, "--provisional")),
    holdout: path.resolve(argument(args, "--holdout")),
    reviewerA: path.resolve(argument(args, "--reviewer-a")),
    reviewerB: path.resolve(argument(args, "--reviewer-b")),
  };
  const physicalRepositoryRoot = await realpath(repositoryRoot);
  const physicalInputs = await Promise.all(Object.values(inputs).map((file) => realpath(file)));
  invariant(Object.values(inputs).every((file) => !inside(repositoryRoot, file))
    && physicalInputs.every((file) => !inside(physicalRepositoryRoot, file)), "private Eval inputs must remain outside the repository");
  invariant(!Object.values(inputs).includes(output), "output cannot overwrite a private Eval input");
  if (inside(repositoryRoot, output)) {
    invariant(inside(path.join(repositoryRoot, "build"), output), "repository-local output must stay under ignored build");
  }
  const artifact = buildPrivateEvalGate({
    coreDataset: await readJson(inputs.core),
    provisionalDataset: await readJson(inputs.provisional),
    holdout: await readJson(inputs.holdout),
    reviewerA: await readJson(inputs.reviewerA),
    reviewerB: await readJson(inputs.reviewerB),
    repository: options.repository || repositoryEvidence(),
  });
  await mkdir(path.dirname(output), { recursive: true });
  const physicalOutputParent = await realpath(path.dirname(output));
  if (inside(physicalRepositoryRoot, physicalOutputParent)) {
    await mkdir(path.join(repositoryRoot, "build"), { recursive: true });
    const physicalBuildRoot = await realpath(path.join(repositoryRoot, "build"));
    invariant(inside(physicalBuildRoot, physicalOutputParent), "repository-local output must stay under ignored build");
  }
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${artifact.annotation_agreement_gate.passed ? "PASS" : "BLOCKED"}: private annotation agreement ${artifact.agreement.gate_kappa.toFixed(6)}; sanitized artifact written; retrieval quality not evaluated\n`);
  if (!artifact.annotation_agreement_gate.passed) process.exitCode = 2;
  return artifact;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch(() => {
    process.stderr.write("BLOCKED: private Eval inputs failed closed validation; no input details were emitted.\n");
    process.exitCode = 2;
  });
}
