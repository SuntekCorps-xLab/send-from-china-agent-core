import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLIC_PRODUCT_FIELDS, toPublicProduct } from "../../governance-worker/src/field-policy.js";
import { candidateUniverseFingerprint, validateHoldout } from "../private-gate/adjudicate.mjs";
import { PRIVATE_LIVE_GATES, validateDataset } from "../v0/dataset.mjs";

export const CORE_CASE_COUNT = 120;
export const HOLDOUT_CASE_COUNT = 30;
export const TRAINING_CASE_COUNT = 90;
export const PROVISIONAL_CASE_COUNT = 180;
export const PRIORITY_KNOWN_STOCK_COUNT = 200;
export const SURFACES = Object.freeze(["http", "mcp", "chat", "storefront"]);
const TRANSPORT_PROFILE_BY_SURFACE = Object.freeze({
  http: "search_v2_http",
  mcp: "mcp_jsonrpc_tools_call",
  chat: "mini_chat_bff",
  storefront: "reference_storefront_bff",
});

const SCHEMA_VERSION = "send-from-china-private-score-artifact/v1";
const RUNTIME_SCHEMA = "send-from-china-private-runtime-manifest/v1";
const POOL_SCHEMA = "send-from-china-private-pool/v1";
const PREDICTION_SCHEMA = "send-from-china-private-predictions/v1";
const AGREEMENT_SCHEMA = "send-from-china-private-eval-gate/v1";
const RUNNER_VERSION = "private-prediction-score-v1.0.0";
const STATUSES = new Set(["results", "needs_clarification", "no_match", "degraded"]);
const EXECUTION_STATES = new Set(["ok", "timeout", "transport_error", "contract_error"]);
const POOL_LANES = new Set([
  "legacy", "meili_lexical", "bge_vector", "alias", "shopify_fallback",
  "known_positive", "approved_negative",
]);
const POOL_REASONS = new Set(["accessory_mismatch", "tenant_scope", "other_policy"]);
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const CASE_ID = /^[a-z0-9][a-z0-9_-]{2,80}$/u;
const PUBLIC_ID = /^[A-Za-z0-9]{22}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const MODEL_IDENTIFIER = /^[A-Za-z0-9@][A-Za-z0-9._:@/+\-]{0,199}$/u;
const MAX_SMALL_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_DATA_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_PREDICTION_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 640 * 1024 * 1024;
const MAX_JSON_NESTING = 128;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fieldPolicyPath = fileURLToPath(new URL("../../governance-worker/src/field-policy.js", import.meta.url));
const publicAttributePolicyPath = fileURLToPath(new URL(
  "../../contracts/public-product-attribute-policy.v1.json", import.meta.url,
));
const agreementRunnerPath = fileURLToPath(new URL("../private-gate/adjudicate.mjs", import.meta.url));
const RAW_METRICS = Symbol("raw_metrics");
const RAW_LATENCY = Symbol("raw_latency");

function invariant(condition, code) {
  if (!condition) {
    const error = new TypeError(code);
    error.code = code;
    throw error;
  }
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function finite(value, minimum = -Infinity, maximum = Infinity) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function validIsoDateTime(value) {
  if (typeof value !== "string" || value.length > 40) return false;
  const match = /^([2-9]\d{3})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const milliseconds = Number(fraction.padEnd(3, "0"));
  const epoch = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour),
    Number(minute), Number(second), milliseconds);
  if (!Number.isFinite(epoch)) return false;
  const expected = `${year}-${month}-${day}T${hour}:${minute}:${second}.${String(milliseconds).padStart(3, "0")}Z`;
  return new Date(epoch).toISOString() === expected;
}

function rounded(value) {
  return Number(value.toFixed(6));
}

export function meetsShadowLift(legacy, candidate) {
  invariant(exactKeys(legacy, new Set(["ndcg_at_10", "recall_at_20"]))
    && exactKeys(candidate, new Set(["ndcg_at_10", "recall_at_20"]))
    && Object.values(legacy).every((value) => finite(value, 0, 1))
    && Object.values(candidate).every((value) => finite(value, 0, 1)),
  "SHADOW_LIFT_INPUT_INVALID");
  return candidate.ndcg_at_10 - legacy.ndcg_at_10 + Number.EPSILON >= 0.03
    || candidate.recall_at_20 - legacy.recall_at_20 + Number.EPSILON >= 0.02;
}

export function meetsPrecisionNonRegression(legacy, candidate) {
  invariant(finite(legacy, 0, 1) && finite(candidate, 0, 1), "PRECISION_COMPARISON_INVALID");
  return candidate + 0.01 + Number.EPSILON >= legacy;
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : NaN;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalDigest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function runnerSourceDigest() {
  const files = [
    fileURLToPath(import.meta.url),
    agreementRunnerPath,
    fileURLToPath(new URL("../v0/dataset.mjs", import.meta.url)),
    fieldPolicyPath,
    publicAttributePolicyPath,
    fileURLToPath(new URL("../../contracts/search-v2-response.schema.json", import.meta.url)),
  ];
  return canonicalDigest(files.map((file) => readFileSync(file, "utf8")));
}

const RUNNER_SOURCE_SHA256 = runnerSourceDigest();
const AGREEMENT_RUNNER_SOURCE_SHA256 = canonicalDigest(readFileSync(agreementRunnerPath, "utf8"));
const PUBLIC_ATTRIBUTE_POLICY = JSON.parse(readFileSync(publicAttributePolicyPath, "utf8"));
invariant(PUBLIC_ATTRIBUTE_POLICY?.schema_version === "public-product-attributes/v1"
  && Array.isArray(PUBLIC_ATTRIBUTE_POLICY.enum)
  && PUBLIC_ATTRIBUTE_POLICY.enum.length > 0
  && new Set(PUBLIC_ATTRIBUTE_POLICY.enum).size === PUBLIC_ATTRIBUTE_POLICY.enum.length
  && PUBLIC_ATTRIBUTE_POLICY.enum.every((name) => /^[a-z][a-z0-9_]{0,79}$/u.test(name)),
"PUBLIC_ATTRIBUTE_POLICY_INVALID");
const PUBLIC_PRODUCT_ATTRIBUTE_FIELDS = Object.freeze([...PUBLIC_ATTRIBUTE_POLICY.enum]);
const PUBLIC_PRODUCT_ATTRIBUTE_FIELD_SET = new Set(PUBLIC_PRODUCT_ATTRIBUTE_FIELDS);
export const PUBLIC_FIELD_ALLOWLIST_SHA256 = canonicalDigest({
  product_fields: PUBLIC_PRODUCT_FIELDS,
  attribute_fields: PUBLIC_PRODUCT_ATTRIBUTE_FIELDS,
});
export const AGENT_CORE_SEARCH_CONTRACT_SHA256 = createHash("sha256")
  .update(readFileSync(fileURLToPath(new URL("../../contracts/search-v2-response.schema.json", import.meta.url))))
  .digest("hex");

// JSON.parse silently accepts duplicate keys. Private inputs fail closed instead.
export function parseStrictJson(text) {
  let cursor = 0;
  const whitespace = () => {
    while (/[ \t\r\n]/u.test(text[cursor] || "")) cursor += 1;
  };
  const parseString = () => {
    invariant(text[cursor] === '"', "PRIVATE_SCORE_JSON_INVALID");
    const start = cursor;
    cursor += 1;
    let escaped = false;
    while (cursor < text.length) {
      const character = text[cursor];
      if (!escaped && character === '"') {
        cursor += 1;
        try {
          return JSON.parse(text.slice(start, cursor));
        } catch {
          invariant(false, "PRIVATE_SCORE_JSON_INVALID");
        }
      }
      invariant(character.charCodeAt(0) >= 0x20, "PRIVATE_SCORE_JSON_INVALID");
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
      cursor += 1;
    }
    invariant(false, "PRIVATE_SCORE_JSON_INVALID");
  };
  const parseValue = (depth = 0) => {
    invariant(depth <= MAX_JSON_NESTING, "PRIVATE_SCORE_JSON_NESTING_EXCEEDED");
    whitespace();
    const character = text[cursor];
    if (character === '"') return parseString();
    if (character === "{") {
      cursor += 1;
      whitespace();
      const output = Object.create(null);
      const keys = new Set();
      if (text[cursor] === "}") {
        cursor += 1;
        return output;
      }
      while (cursor < text.length) {
        whitespace();
        const key = parseString();
        invariant(!keys.has(key), "PRIVATE_SCORE_DUPLICATE_JSON_KEY");
        keys.add(key);
        whitespace();
        invariant(text[cursor] === ":", "PRIVATE_SCORE_JSON_INVALID");
        cursor += 1;
        output[key] = parseValue(depth + 1);
        whitespace();
        if (text[cursor] === "}") {
          cursor += 1;
          return output;
        }
        invariant(text[cursor] === ",", "PRIVATE_SCORE_JSON_INVALID");
        cursor += 1;
      }
      invariant(false, "PRIVATE_SCORE_JSON_INVALID");
    }
    if (character === "[") {
      cursor += 1;
      whitespace();
      const output = [];
      if (text[cursor] === "]") {
        cursor += 1;
        return output;
      }
      while (cursor < text.length) {
        output.push(parseValue(depth + 1));
        whitespace();
        if (text[cursor] === "]") {
          cursor += 1;
          return output;
        }
        invariant(text[cursor] === ",", "PRIVATE_SCORE_JSON_INVALID");
        cursor += 1;
      }
      invariant(false, "PRIVATE_SCORE_JSON_INVALID");
    }
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, cursor)) {
        cursor += literal.length;
        return value;
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(cursor));
    invariant(match, "PRIVATE_SCORE_JSON_INVALID");
    cursor += match[0].length;
    const value = Number(match[0]);
    invariant(Number.isFinite(value), "PRIVATE_SCORE_JSON_INVALID");
    return value;
  };
  const output = parseValue();
  whitespace();
  invariant(cursor === text.length, "PRIVATE_SCORE_JSON_INVALID");
  return output;
}

function validatePrivateDataset(dataset, expectedCount, label) {
  try {
    validateDataset(dataset);
  } catch {
    invariant(false, `${label}_INVALID`);
  }
  invariant(dataset.provenance === "private_live", `${label}_PROVENANCE_INVALID`);
  invariant(dataset.cases.length === expectedCount, `${label}_CASE_COUNT_INVALID`);
  for (const [field, value] of Object.entries(PRIVATE_LIVE_GATES)) {
    invariant(dataset.gates[field] === value, `${label}_GATES_MUTATED`);
  }
  return dataset;
}

function validateAgreement(artifact, repository, hashes) {
  invariant(exactKeys(artifact, new Set([
    "schema_version", "generated_at", "provenance", "runner", "repository",
    "input_fingerprint_sha256", "datasets", "agreement", "adjudication",
    "annotation_agreement_gate", "boundaries",
  ])), "AGREEMENT_ARTIFACT_INVALID");
  invariant(artifact.schema_version === AGREEMENT_SCHEMA
    && validIsoDateTime(artifact.generated_at)
    && artifact.provenance === "private_live_aggregate_only"
    && SHA256.test(artifact.input_fingerprint_sha256), "AGREEMENT_ARTIFACT_INVALID");
  invariant(exactKeys(artifact.runner, new Set(["version", "source_sha256"]))
    && artifact.runner.version === "private-eval-agreement-v1.1.0"
    && artifact.runner.source_sha256 === AGREEMENT_RUNNER_SOURCE_SHA256,
  "AGREEMENT_RUNNER_INVALID");
  invariant(exactKeys(artifact.repository, new Set(["commit", "working_tree_dirty"]))
    && artifact.repository.commit === repository.commit
    && artifact.repository.working_tree_dirty === false, "AGREEMENT_REPOSITORY_MISMATCH");
  invariant(exactKeys(artifact.datasets, new Set([
    "core_sha256", "provisional_sha256", "holdout_assignment_sha256", "core_case_count",
    "training_case_count", "hidden_holdout_case_count", "provisional_case_count",
    "candidate_universe_sha256",
  ])), "AGREEMENT_DATASETS_INVALID");
  for (const field of [
    "core_sha256", "provisional_sha256", "holdout_assignment_sha256", "candidate_universe_sha256",
  ]) invariant(SHA256.test(artifact.datasets[field]), "AGREEMENT_DATASETS_INVALID");
  invariant(artifact.datasets.core_sha256 === hashes.core
    && artifact.datasets.provisional_sha256 === hashes.provisional
    && artifact.datasets.holdout_assignment_sha256 === hashes.holdout
    && artifact.datasets.core_case_count === CORE_CASE_COUNT
    && artifact.datasets.training_case_count === TRAINING_CASE_COUNT
    && artifact.datasets.hidden_holdout_case_count === HOLDOUT_CASE_COUNT
    && artifact.datasets.provisional_case_count === PROVISIONAL_CASE_COUNT,
  "AGREEMENT_DATASETS_MISMATCH");
  invariant(exactKeys(artifact.annotation_agreement_gate, new Set([
    "minimum_kappa", "labeling_rules_locked", "passed",
  ])) && artifact.annotation_agreement_gate.minimum_kappa === 0.8
    && artifact.annotation_agreement_gate.labeling_rules_locked === true
    && artifact.annotation_agreement_gate.passed === true, "AGREEMENT_GATE_NOT_PASSED");
  invariant(exactKeys(artifact.agreement, new Set([
    "status_kappa", "relevance_quadratic_weighted_kappa", "forbidden_binary_kappa",
    "status_disagreement_count", "relevance_disagreement_count",
    "forbidden_disagreement_count", "gate_kappa",
  ])) && ["status_kappa", "relevance_quadratic_weighted_kappa", "forbidden_binary_kappa", "gate_kappa"]
    .every((field) => finite(artifact.agreement[field], -1, 1))
    && ["status_disagreement_count", "relevance_disagreement_count", "forbidden_disagreement_count"]
      .every((field) => Number.isInteger(artifact.agreement[field]) && artifact.agreement[field] >= 0)
    && artifact.agreement.gate_kappa === Math.min(
      artifact.agreement.status_kappa,
      artifact.agreement.relevance_quadratic_weighted_kappa,
      artifact.agreement.forbidden_binary_kappa,
    ) && artifact.agreement.gate_kappa >= 0.8, "AGREEMENT_KAPPA_INVALID");
  invariant(exactKeys(artifact.adjudication, new Set([
    "unsupported_decision_count", "resolved_status_disagreement_count",
    "resolved_relevance_disagreement_count", "resolved_forbidden_disagreement_count",
  ])) && Object.values(artifact.adjudication)
    .every((value) => Number.isInteger(value) && value >= 0)
    && artifact.adjudication.unsupported_decision_count === 0, "AGREEMENT_UNSUPPORTED_DECISIONS");
  invariant(exactKeys(artifact.boundaries, new Set([
    "contains_case_ids", "contains_queries", "contains_product_ids", "contains_reviewer_identity",
    "evaluates_retrieval_quality", "scores_hidden_holdout", "scores_provisional_regression",
    "authorizes_search_rollout",
  ])) && Object.values(artifact.boundaries).every((value) => value === false),
  "AGREEMENT_BOUNDARY_INVALID");
}

function validateRuntime(runtime, inputs, repository) {
  invariant(exactKeys(runtime, new Set([
    "schema_version", "generated_at", "environment", "release", "capture_runner", "measurement",
    "quality_capture",
    "latency_baseline_capture", "datasets", "pool", "surface_adapters", "models",
    "packets", "boundaries",
  ])), "RUNTIME_MANIFEST_INVALID");
  invariant(runtime.schema_version === RUNTIME_SCHEMA && validIsoDateTime(runtime.generated_at)
    && runtime.environment === "isolated_shadow", "RUNTIME_MANIFEST_INVALID");
  const releaseFields = new Set([
    "mini_suntek_commit", "agent_core_commit", "agent_core_search_contract_sha256",
    "reference_store_commit", "root_worker_commit", "root_worker_working_tree_dirty",
  ]);
  invariant(exactKeys(runtime.release, releaseFields), "RUNTIME_RELEASE_INVALID");
  for (const field of ["mini_suntek_commit", "agent_core_commit", "reference_store_commit", "root_worker_commit"]) {
    invariant(COMMIT.test(runtime.release[field]), "RUNTIME_RELEASE_INVALID");
  }
  invariant(SHA256.test(runtime.release.agent_core_search_contract_sha256)
    && runtime.release.agent_core_commit === repository.commit
    && runtime.release.agent_core_search_contract_sha256 === AGENT_CORE_SEARCH_CONTRACT_SHA256
    && runtime.release.root_worker_working_tree_dirty === false, "RUNTIME_RELEASE_MISMATCH");
  invariant(exactKeys(runtime.capture_runner, new Set(["version", "source_sha256"]))
    && VERSION.test(runtime.capture_runner.version)
    && SHA256.test(runtime.capture_runner.source_sha256), "RUNTIME_CAPTURE_RUNNER_INVALID");
  invariant(exactKeys(runtime.measurement, new Set([
    "warmup_requests_per_surface", "warmups_excluded_from_metrics", "measured_attempts_per_case",
    "schedule", "schedule_seed_sha256", "maximum_arm_capture_skew_seconds", "timeout_ms",
    "timeout_samples_retained", "clock",
  ])) && Number.isInteger(runtime.measurement.warmup_requests_per_surface)
    && runtime.measurement.warmup_requests_per_surface >= 1
    && runtime.measurement.warmup_requests_per_surface <= 100
    && runtime.measurement.warmups_excluded_from_metrics === true
    && runtime.measurement.measured_attempts_per_case === 1
    && runtime.measurement.schedule === "seeded_arm_interleave"
    && SHA256.test(runtime.measurement.schedule_seed_sha256)
    && Number.isInteger(runtime.measurement.maximum_arm_capture_skew_seconds)
    && runtime.measurement.maximum_arm_capture_skew_seconds >= 1
    && runtime.measurement.maximum_arm_capture_skew_seconds <= 3600
    && runtime.measurement.timeout_ms === 5000
    && runtime.measurement.timeout_samples_retained === true
    && runtime.measurement.clock === "monotonic", "RUNTIME_MEASUREMENT_INVALID");
  const qualityFields = new Set([
    "deployment_id", "deployment_config_sha256", "catalog_snapshot_sha256", "index_snapshot_sha256",
    "tenant_policy_sha256", "deployed_field_policy_sha256", "scorer_required_allowlist_sha256",
    "hard_constraint_evaluator_sha256",
    "request_packet_sha256", "candidate_retrieval_recipe_sha256", "authoritative_selector", "shadow_selector",
  ]);
  invariant(exactKeys(runtime.quality_capture, qualityFields), "RUNTIME_QUALITY_CAPTURE_INVALID");
  invariant(typeof runtime.quality_capture.deployment_id === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{31,127}$/u.test(runtime.quality_capture.deployment_id)
    && !runtime.quality_capture.deployment_id.includes("://"), "RUNTIME_DEPLOYMENT_ID_INVALID");
  for (const field of [...qualityFields].filter((field) => field.endsWith("sha256"))) {
    invariant(SHA256.test(runtime.quality_capture[field]), "RUNTIME_QUALITY_CAPTURE_INVALID");
  }
  invariant(runtime.quality_capture.authoritative_selector === "legacy"
    && ["rrf", "rrf_reranker"].includes(runtime.quality_capture.shadow_selector)
    && runtime.quality_capture.scorer_required_allowlist_sha256 === PUBLIC_FIELD_ALLOWLIST_SHA256,
  "RUNTIME_QUALITY_CAPTURE_INVALID");
  const baselineFields = new Set([
    "deployment_id", "deployment_config_sha256", "catalog_snapshot_sha256", "index_snapshot_sha256",
    "tenant_policy_sha256", "request_packet_sha256", "fusion_mode", "rerank_mode", "evidence_rag_mode",
  ]);
  invariant(exactKeys(runtime.latency_baseline_capture, baselineFields), "RUNTIME_BASELINE_INVALID");
  invariant(typeof runtime.latency_baseline_capture.deployment_id === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{31,127}$/u.test(runtime.latency_baseline_capture.deployment_id),
  "RUNTIME_BASELINE_INVALID");
  for (const field of [...baselineFields].filter((field) => field.endsWith("sha256"))) {
    invariant(SHA256.test(runtime.latency_baseline_capture[field]), "RUNTIME_BASELINE_INVALID");
  }
  invariant(runtime.latency_baseline_capture.catalog_snapshot_sha256 === runtime.quality_capture.catalog_snapshot_sha256
    && runtime.latency_baseline_capture.index_snapshot_sha256 === runtime.quality_capture.index_snapshot_sha256
    && runtime.latency_baseline_capture.tenant_policy_sha256 === runtime.quality_capture.tenant_policy_sha256
    && runtime.latency_baseline_capture.request_packet_sha256 === runtime.quality_capture.request_packet_sha256
    && runtime.quality_capture.request_packet_sha256 === runtime.packets.query_packet_sha256
    && runtime.latency_baseline_capture.fusion_mode === "legacy"
    && runtime.latency_baseline_capture.rerank_mode === "off"
    && runtime.latency_baseline_capture.evidence_rag_mode === "off", "RUNTIME_BASELINE_MISMATCH");
  invariant(exactKeys(runtime.datasets, new Set([
    "core_canonical_sha256", "provisional_canonical_sha256", "holdout_canonical_sha256",
    "agreement_artifact_sha256",
  ])) && runtime.datasets.core_canonical_sha256 === inputs.hashes.core
    && runtime.datasets.provisional_canonical_sha256 === inputs.hashes.provisional
    && runtime.datasets.holdout_canonical_sha256 === inputs.hashes.holdout
    && runtime.datasets.agreement_artifact_sha256 === inputs.hashes.agreement,
  "RUNTIME_DATASET_BINDING_MISMATCH");
  invariant(exactKeys(runtime.pool, new Set([
    "pool_recipe_version", "pool_recipe_sha256", "pool_manifest_sha256",
  ])) && VERSION.test(runtime.pool.pool_recipe_version)
    && runtime.pool.pool_recipe_sha256 === canonicalDigest(inputs.pool.recipe)
    && runtime.pool.pool_manifest_sha256 === inputs.hashes.pool
    && runtime.quality_capture.candidate_retrieval_recipe_sha256 === runtime.pool.pool_recipe_sha256,
  "RUNTIME_POOL_BINDING_MISMATCH");
  invariant(exactKeys(runtime.surface_adapters, new Set(SURFACES)), "RUNTIME_ADAPTERS_INVALID");
  for (const surface of SURFACES) {
    const adapter = runtime.surface_adapters[surface];
    invariant(exactKeys(adapter, new Set([
      "version", "source_sha256", "transport_profile", "transport_contract_sha256", "targets",
    ])) && VERSION.test(adapter.version) && SHA256.test(adapter.source_sha256)
      && adapter.transport_profile === TRANSPORT_PROFILE_BY_SURFACE[surface]
      && SHA256.test(adapter.transport_contract_sha256)
      && exactKeys(adapter.targets, new Set(["legacy", "candidate"])), "RUNTIME_ADAPTERS_INVALID");
    for (const arm of ["legacy", "candidate"]) {
      const target = adapter.targets[arm];
      const coreCapture = arm === "legacy"
        ? runtime.latency_baseline_capture
        : runtime.quality_capture;
      const directCore = ["http", "mcp"].includes(surface);
      invariant(exactKeys(target, new Set([
        "kind", "deployment_id", "config_sha256", "upstream_core_deployment_id_sha256",
        "upstream_core_config_sha256", "routing_receipt_sha256",
      ]))
        && target.kind === (directCore ? "direct_core" : "bff")
        && typeof target.deployment_id === "string"
        && /^[A-Za-z0-9][A-Za-z0-9._-]{31,127}$/u.test(target.deployment_id)
        && SHA256.test(target.config_sha256)
        && target.upstream_core_deployment_id_sha256 === canonicalDigest(coreCapture.deployment_id)
        && target.upstream_core_config_sha256 === coreCapture.deployment_config_sha256
        && SHA256.test(target.routing_receipt_sha256)
        && (!directCore || (target.deployment_id === coreCapture.deployment_id
          && target.config_sha256 === coreCapture.deployment_config_sha256)),
      "RUNTIME_SURFACE_TARGET_INVALID");
    }
  }
  invariant(Array.isArray(runtime.models) && runtime.models.length >= 1
    && runtime.models.length <= 3, "RUNTIME_MODELS_INVALID");
  const modelRoles = new Set();
  for (const model of runtime.models) {
    invariant(exactKeys(model, new Set(["role", "provider_model_id", "revision", "config_sha256"]))
      && ["embedding", "reranker", "intent"].includes(model.role)
      && !modelRoles.has(model.role) && MODEL_IDENTIFIER.test(model.provider_model_id)
      && MODEL_IDENTIFIER.test(model.revision) && SHA256.test(model.config_sha256), "RUNTIME_MODELS_INVALID");
    modelRoles.add(model.role);
  }
  invariant(modelRoles.has("embedding")
    && (runtime.quality_capture.shadow_selector !== "rrf_reranker" || modelRoles.has("reranker")),
  "RUNTIME_MODELS_INCOMPLETE");
  invariant(exactKeys(runtime.packets, new Set([
    "query_packet_sha256", "agent_task_packet_sha256", "adversarial_packet_sha256",
  ])) && Object.values(runtime.packets).every((value) => SHA256.test(value)), "RUNTIME_PACKETS_INVALID");
  invariant(exactKeys(runtime.boundaries, new Set([
    "production_writes_enabled", "live_invites_activated", "raw_query_logging_enabled", "retry_policy",
  ])) && runtime.boundaries.production_writes_enabled === false
    && runtime.boundaries.live_invites_activated === false
    && runtime.boundaries.raw_query_logging_enabled === false
    && runtime.boundaries.retry_policy === "none", "RUNTIME_BOUNDARIES_INVALID");
}

function poolFingerprint(rows) {
  return candidateUniverseFingerprint(new Map(rows.map((row) => [row.case_id, {
    candidates: row.candidate_ids.map((publicId) => ({ public_id: publicId, grade: 0 })),
  }])));
}

function validatePool(pool, coreDataset, provisionalDataset, hashes, runtime) {
  invariant(exactKeys(pool, new Set([
    "schema_version", "generated_at", "pool_recipe_version", "recipe", "datasets", "cases",
    "fingerprints", "approval",
  ])), "POOL_MANIFEST_INVALID");
  invariant(pool.schema_version === POOL_SCHEMA && validIsoDateTime(pool.generated_at)
    && VERSION.test(pool.pool_recipe_version)
    && pool.pool_recipe_version === runtime.pool.pool_recipe_version, "POOL_MANIFEST_INVALID");
  invariant(exactKeys(pool.recipe, new Set([
    "frozen_before_annotation", "candidate_config_frozen_before_pool", "blinded_source_and_rank",
    "dedupe_key", "max_candidates_per_case", "presentation_seed_sha256", "sources",
  ])) && pool.recipe.frozen_before_annotation === true
    && pool.recipe.candidate_config_frozen_before_pool === true
    && pool.recipe.blinded_source_and_rank === true
    && pool.recipe.dedupe_key === "public_id" && pool.recipe.max_candidates_per_case === 500
    && SHA256.test(pool.recipe.presentation_seed_sha256) && Array.isArray(pool.recipe.sources),
  "POOL_RECIPE_INVALID");
  const observedLanes = new Set();
  const sourceIds = new Set();
  for (const source of pool.recipe.sources) {
    invariant(exactKeys(source, new Set([
      "source_id", "lane", "top_k", "config_sha256", "model_revision", "model_config_sha256",
      "model_identity_sha256", "index_revision_sha256",
    ])) && VERSION.test(source.source_id) && !sourceIds.has(source.source_id)
      && POOL_LANES.has(source.lane) && Number.isInteger(source.top_k)
      && source.top_k >= 1 && source.top_k <= 500 && SHA256.test(source.config_sha256)
      && VERSION.test(source.model_revision)
      && (source.model_config_sha256 === null || SHA256.test(source.model_config_sha256))
      && (source.model_identity_sha256 === null || SHA256.test(source.model_identity_sha256))
      && SHA256.test(source.index_revision_sha256),
    "POOL_SOURCE_INVALID");
    sourceIds.add(source.source_id);
    observedLanes.add(source.lane);
  }
  invariant([...POOL_LANES].every((lane) => observedLanes.has(lane)), "POOL_LANE_MISSING");
  const embedding = runtime.models.find((model) => model.role === "embedding");
  const vectorSources = pool.recipe.sources.filter((source) => source.lane === "bge_vector");
  invariant(embedding && vectorSources.length === 1
    && vectorSources[0].model_revision === embedding.revision
    && vectorSources[0].model_config_sha256 === embedding.config_sha256
    && vectorSources[0].model_identity_sha256 === canonicalDigest(embedding),
  "POOL_EMBEDDING_MODEL_MISMATCH");
  invariant(exactKeys(pool.datasets, new Set([
    "core_canonical_sha256", "provisional_canonical_sha256", "catalog_snapshot_sha256",
    "index_snapshot_sha256", "tenant_policy_sha256",
  ]))
    && pool.datasets.core_canonical_sha256 === hashes.core
    && pool.datasets.provisional_canonical_sha256 === hashes.provisional
    && pool.datasets.catalog_snapshot_sha256 === runtime.quality_capture.catalog_snapshot_sha256
    && pool.datasets.index_snapshot_sha256 === runtime.quality_capture.index_snapshot_sha256
    && pool.datasets.tenant_policy_sha256 === runtime.quality_capture.tenant_policy_sha256,
  "POOL_DATASET_BINDING_MISMATCH");
  const expected = new Map([
    ...coreDataset.cases.map((entry) => [entry.case_id, { dataset: "core", entry }]),
    ...provisionalDataset.cases.map((entry) => [entry.case_id, { dataset: "provisional", entry }]),
  ]);
  invariant(Array.isArray(pool.cases) && pool.cases.length === CORE_CASE_COUNT + PROVISIONAL_CASE_COUNT,
    "POOL_CASE_COUNT_INVALID");
  const seen = new Set();
  const priorityRanks = new Set();
  for (const row of pool.cases) {
    invariant(exactKeys(row, new Set([
      "case_id", "dataset", "priority_known_stock_rank", "known_stock_evidence_sha256",
      "known_stock_evidence_catalog_snapshot_sha256", "candidate_ids", "forbidden_reason_labels",
    ])) && CASE_ID.test(row.case_id) && !seen.has(row.case_id) && expected.has(row.case_id),
    "POOL_CASE_INVALID");
    seen.add(row.case_id);
    const expectedCase = expected.get(row.case_id);
    invariant(row.dataset === expectedCase.dataset, "POOL_CASE_COHORT_MISMATCH");
    invariant(Array.isArray(row.candidate_ids) && row.candidate_ids.length >= 1
      && row.candidate_ids.length <= 500 && row.candidate_ids.length === new Set(row.candidate_ids).size
      && row.candidate_ids.every((id) => PUBLIC_ID.test(id)), "POOL_CANDIDATES_INVALID");
    const candidateIds = new Set(row.candidate_ids);
    const positiveIds = expectedCase.entry.expected.relevance.map((item) => item.public_id);
    invariant(positiveIds.every((id) => candidateIds.has(id))
      && expectedCase.entry.expected.forbidden_ids.every((id) => candidateIds.has(id)),
    "POOL_MISSING_JUDGMENT");
    invariant(Array.isArray(row.forbidden_reason_labels), "POOL_REASON_LABELS_INVALID");
    const labeledIds = new Set();
    for (const label of row.forbidden_reason_labels) {
      invariant(exactKeys(label, new Set(["public_id", "reasons"]))
        && candidateIds.has(label.public_id) && !labeledIds.has(label.public_id)
        && !positiveIds.includes(label.public_id)
        && Array.isArray(label.reasons) && label.reasons.length >= 1
        && label.reasons.length === new Set(label.reasons).size
        && label.reasons.every((reason) => POOL_REASONS.has(reason)), "POOL_REASON_LABELS_INVALID");
      labeledIds.add(label.public_id);
    }
    invariant(expectedCase.entry.expected.forbidden_ids.every((id) => labeledIds.has(id)),
      "POOL_FORBIDDEN_REASON_MISSING");
    if (row.priority_known_stock_rank === null) {
      invariant(row.known_stock_evidence_sha256 === null
        && row.known_stock_evidence_catalog_snapshot_sha256 === null,
      "POOL_KNOWN_STOCK_EVIDENCE_INVALID");
    } else {
      invariant(Number.isInteger(row.priority_known_stock_rank)
        && row.priority_known_stock_rank >= 1 && row.priority_known_stock_rank <= PRIORITY_KNOWN_STOCK_COUNT
        && !priorityRanks.has(row.priority_known_stock_rank)
        && SHA256.test(row.known_stock_evidence_sha256)
        && row.known_stock_evidence_catalog_snapshot_sha256
          === runtime.quality_capture.catalog_snapshot_sha256
        && expectedCase.entry.expected.status === "results" && positiveIds.length > 0,
      "POOL_KNOWN_STOCK_INVALID");
      priorityRanks.add(row.priority_known_stock_rank);
    }
  }
  invariant(seen.size === expected.size && priorityRanks.size === PRIORITY_KNOWN_STOCK_COUNT
    && [...Array(PRIORITY_KNOWN_STOCK_COUNT)].every((_, index) => priorityRanks.has(index + 1)),
  "POOL_KNOWN_STOCK_COUNT_INVALID");
  const coreRows = pool.cases.filter((row) => row.dataset === "core");
  const provisionalRows = pool.cases.filter((row) => row.dataset === "provisional");
  const coreFingerprint = poolFingerprint(coreRows);
  const provisionalFingerprint = poolFingerprint(provisionalRows);
  invariant(exactKeys(pool.fingerprints, new Set([
    "core_candidate_universe_sha256", "provisional_candidate_universe_sha256",
  ])) && pool.fingerprints.core_candidate_universe_sha256 === coreFingerprint
    && pool.fingerprints.provisional_candidate_universe_sha256 === provisionalFingerprint,
  "POOL_FINGERPRINT_MISMATCH");
  invariant(exactKeys(pool.approval, new Set([
    "known_positive_negative_receipt_sha256", "provisional_label_approval_sha256",
  ])) && Object.values(pool.approval).every((value) => SHA256.test(value)), "POOL_APPROVAL_INVALID");
  return { coreFingerprint, provisionalFingerprint };
}

function sensitiveFieldName(value) {
  const name = String(value || "").trim().replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  return !PUBLIC_PRODUCT_ATTRIBUTE_FIELD_SET.has(String(value || ""))
    || /^(?:access|account|api|auth|authorization|bearer|client|cookie|credential|customer|email|internal|margin|password|phone|private|secret|session|supplier|tenant|token|vendor|warehouse)(?:_|$)/u.test(name)
    || /^(?:cost|wholesale)(?:_|$)/u.test(name)
    || /^source_(?:id|url|record|reference)$/u.test(name)
    || /_(?:token|secret|key|password|cookie|session|email|phone|address|name|id|url)$/u.test(name);
}

function tenantFieldName(value) {
  const name = String(value || "").trim().replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  return /^(?:tenant_id|tenant_key|tenant_secret|customer_id|account_id)$/u.test(name);
}

function privateIpv4(hostname) {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet)
    || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
}

function privateNetworkHost(value) {
  const hostname = String(value || "").trim().toLowerCase()
    .replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")
    || /\.(?:internal|local|corp)$/u.test(hostname)) return true;
  const version = isIP(hostname);
  if (version === 4) return privateIpv4(hostname);
  if (version !== 6) return false;
  if (hostname === "::" || hostname === "::1") return true;
  if (hostname.startsWith("::ffff:")) {
    const mapped = hostname.slice("::ffff:".length);
    if (isIP(mapped) === 4) return privateIpv4(mapped);
    const pair = mapped.split(":");
    if (pair.length === 2 && pair.every((item) => /^[0-9a-f]{1,4}$/u.test(item))) {
      const numeric = (Number.parseInt(pair[0], 16) * 65536) + Number.parseInt(pair[1], 16);
      return privateIpv4([
        (numeric >>> 24) & 255, (numeric >>> 16) & 255, (numeric >>> 8) & 255, numeric & 255,
      ].join("."));
    }
  }
  const first = Number.parseInt(hostname.split(":").find((item) => item.length > 0) || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

function containsPrivateNetworkUrl(value) {
  for (const match of String(value).matchAll(/https?:\/\/[^\s<>"']+/giu)) {
    const candidate = match[0].replace(/[),.;!?]+$/gu, "");
    try {
      const url = new URL(candidate);
      if (["http:", "https:"].includes(url.protocol)
        && (url.username || url.password || privateNetworkHost(url.hostname))) return true;
    } catch {
      // Invalid URLs are handled by field semantics where a URL is required.
    }
  }
  return false;
}

function sensitiveScalarValue(value) {
  if (typeof value !== "string") return false;
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/iu.test(value)
    || /\b(?:github_pat|ghp|gho|ghu|ghs|ghr|sk_live|shpat|shpca|shppa)_[A-Za-z0-9_-]{12,}\b/iu.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/u.test(value)
    || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(value)
    || /(?:^|[?&;\s])(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|credential|password|session|signature|token)\s*[=:]\s*[^&;\s]{6,}/iu.test(value)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(value)
    || containsPrivateNetworkUrl(value);
}

function containsSensitivePublicValue(value, seen = new Set()) {
  if (sensitiveScalarValue(value)) return true;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsSensitivePublicValue(item, seen));
  return Object.values(value).some((item) => containsSensitivePublicValue(item, seen));
}

function fieldViolations(product) {
  let privateCount = 0;
  let tenantCount = 0;
  if (!product || typeof product !== "object" || Array.isArray(product)) {
    return { privateCount: 1, tenantCount: 0, publicProduct: null };
  }
  for (const key of Object.keys(product)) {
    if (!PUBLIC_PRODUCT_FIELDS.includes(key)) privateCount += 1;
    if (tenantFieldName(key)) tenantCount += 1;
  }
  if (typeof product.title !== "string" || product.title.length < 1
    || product.title.length > 300 || !/\S/u.test(product.title)) privateCount += 1;
  if (product.price && typeof product.price === "object" && !Array.isArray(product.price)) {
    for (const key of Object.keys(product.price)) {
      if (!["amount", "currency", "tier"].includes(key)) privateCount += 1;
      if (tenantFieldName(key)) tenantCount += 1;
    }
    if (typeof product.price.amount !== "number") privateCount += 1;
  }
  if (Array.isArray(product.images)) {
    for (const image of product.images) {
      if (!image || typeof image !== "object" || Array.isArray(image)) {
        privateCount += 1;
        continue;
      }
      for (const key of Object.keys(image)) {
        if (!["url", "alt"].includes(key)) privateCount += 1;
        if (tenantFieldName(key)) tenantCount += 1;
      }
      try {
        const parsed = new URL(String(image.url || ""));
        if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) privateCount += 1;
      } catch {
        privateCount += 1;
      }
    }
  }
  if (product.attributes && typeof product.attributes === "object" && !Array.isArray(product.attributes)) {
    for (const [key, value] of Object.entries(product.attributes)) {
      if (sensitiveFieldName(key) || (value && typeof value === "object")) privateCount += 1;
      if (tenantFieldName(key)) tenantCount += 1;
    }
  }
  if (product.lead_time_days !== undefined && !Number.isInteger(product.lead_time_days)) privateCount += 1;
  if (product.as_of !== undefined && !validIsoDateTime(product.as_of)) privateCount += 1;
  if (containsSensitivePublicValue(product)) privateCount += 1;
  let publicProduct = null;
  try {
    publicProduct = toPublicProduct(product);
    if (product.attributes && Object.keys(product.attributes).length !== Object.keys(publicProduct.attributes || {}).length) {
      privateCount += 1;
    }
  } catch {
    privateCount += 1;
  }
  return { privateCount, tenantCount, publicProduct };
}

function tokens(value) {
  return String(value ?? "").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) || [];
}

function includesCriterion(text, criterion) {
  const haystack = new Set(tokens(text));
  const needles = tokens(criterion);
  return needles.length > 0 && needles.every((word) => haystack.has(word));
}

function criteria(value) {
  return Array.isArray(value) ? value : [value];
}

function productText(product) {
  return [product?.title, product?.description, product?.category, ...(product?.tags || []),
    ...Object.values(product?.attributes || {})].join(" ");
}

function satisfiesHardConstraint(product, condition) {
  if (!product) return false;
  const expected = criteria(condition.value);
  if (condition.name === "price_max") {
    return finite(Number(product?.price?.amount), 0) && expected.every((value) => Number(product.price.amount) <= Number(value));
  }
  if (condition.name === "price_min") {
    return finite(Number(product?.price?.amount), 0) && expected.every((value) => Number(product.price.amount) >= Number(value));
  }
  if (condition.name === "material" || condition.name === "color") {
    const selected = Object.entries(product.attributes || {})
      .filter(([key]) => tokens(key).includes(condition.name))
      .map(([, value]) => value).join(" ");
    return expected.every((value) => includesCriterion(selected, value));
  }
  if (condition.name === "must_have") return expected.every((value) => includesCriterion(productText(product), value));
  if (condition.name === "exclude") return expected.every((value) => !includesCriterion(productText(product), value));
  return false;
}

function sourceStateViolation(surface) {
  if (surface.execution_state !== "ok" && surface.canonical_status !== "degraded") return true;
  if (surface.canonical_status !== "degraded"
    && (surface.source_state.degraded === true || surface.source_state.scan_limit_reached === true)) return true;
  if (surface.canonical_status === "no_match") {
    return surface.source_state.raw_status !== "no_match" || surface.results.length !== 0
      || surface.source_state.plan_complete !== true
      || surface.source_state.scope_exhausted !== true
      || surface.source_state.scan_limit_reached !== false
      || surface.source_state.degraded !== false;
  }
  if (surface.canonical_status === "results") {
    return surface.results.length === 0 || surface.source_state.plan_complete !== true
      || !["results", "catalog_match"].includes(surface.source_state.raw_status);
  }
  if (surface.canonical_status === "needs_clarification") {
    return surface.results.length !== 0 || surface.source_state.raw_status !== "needs_clarification"
      || surface.source_state.degraded !== false || surface.source_state.scan_limit_reached !== false;
  }
  if (surface.canonical_status === "degraded") {
    return surface.results.length !== 0 || surface.source_state.degraded !== true
      || ["results", "catalog_match", "no_match", "needs_clarification"]
        .includes(surface.source_state.raw_status);
  }
  if (surface.canonical_status !== "results" && surface.results.length > 0) return true;
  return false;
}

const RESPONSE_ROOT_FIELDS = new Set([
  "contract_version", "trace_id", "status", "normalized_intent", "relaxations",
  "missing_criteria", "results", "pagination", "search_scope", "compatibility",
]);
const CONDITION_FIELDS = new Set(["name", "value", "source", "scope", "hardness"]);

function decodedPointer(pointer) {
  return String(pointer).split("/").slice(1).map((segment) => segment
    .replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

function allowedObservedPointer(pointer) {
  let parts;
  try {
    parts = decodedPointer(pointer);
  } catch {
    return false;
  }
  if (!parts.length || !RESPONSE_ROOT_FIELDS.has(parts[0])) return false;
  if (parts.length === 1) return true;
  const [root, index, field, nested] = parts;
  if (root === "results") {
    if (!/^\d+$/u.test(index)) return false;
    if (parts.length === 2) return true;
    if (!PUBLIC_PRODUCT_FIELDS.includes(field)) return false;
    if (parts.length === 3) return true;
    if (field === "tags") return parts.length === 4 && /^\d+$/u.test(nested);
    if (field === "images") {
      return (parts.length === 4 && /^\d+$/u.test(nested))
        || (parts.length === 5 && /^\d+$/u.test(nested) && ["url", "alt"].includes(parts[4]));
    }
    if (field === "price") return parts.length === 4 && ["amount", "currency", "tier"].includes(nested);
    if (field === "attributes") return parts.length === 4 && !sensitiveFieldName(nested);
    return false;
  }
  if (root === "normalized_intent") {
    if (!["product_identity", "hard_constraints", "soft_context", "transaction_context"].includes(index)) return false;
    if (parts.length === 2) return true;
    if (index === "product_identity") return parts.length === 3 && CONDITION_FIELDS.has(field);
    if (!/^\d+$/u.test(field)) return false;
    return parts.length === 3 || (parts.length === 4 && CONDITION_FIELDS.has(nested));
  }
  if (root === "relaxations") {
    if (!/^\d+$/u.test(index)) return false;
    if (parts.length === 2) return true;
    if (parts.length === 3) return ["condition", "from", "to", "reason"].includes(field);
    return parts.length === 4 && ["from", "to"].includes(field) && /^\d+$/u.test(nested);
  }
  if (root === "missing_criteria") return parts.length === 2 && /^\d+$/u.test(index);
  if (root === "pagination") return parts.length === 2
    && ["limit", "cursor", "next_cursor", "has_more"].includes(index);
  if (root === "search_scope") return parts.length === 2 && [
    "plan_complete", "scope_exhausted", "global_catalog_exhaustive",
    "scan_limit_reached", "degraded", "degraded_reason",
  ].includes(index);
  if (root === "compatibility") return parts.length === 2 && ["adapter", "legacy_status"].includes(index);
  return false;
}

function pointerLeakCount(pointers) {
  let count = 0;
  for (const pointer of pointers) {
    if (!allowedObservedPointer(pointer)) count += 1;
  }
  return count;
}

function dcg(ids, grades, limit) {
  return ids.slice(0, limit).reduce((total, id, index) => {
    const grade = grades.get(id) || 0;
    return total + ((2 ** grade) - 1) / Math.log2(index + 2);
  }, 0);
}

export function scorePrivateCase(testCase, surface, poolCase) {
  const grades = new Map(testCase.expected.relevance.map((entry) => [entry.public_id, entry.grade]));
  const forbiddenIds = new Set(testCase.expected.forbidden_ids);
  const poolIds = new Set(poolCase.candidate_ids);
  const reasonMap = new Map(poolCase.forbidden_reason_labels.map((entry) => [entry.public_id, new Set(entry.reasons)]));
  const ids = surface.results.map((product) => String(product?.public_id || ""));
  const validIds = ids.filter((id) => PUBLIC_ID.test(id));
  const uniqueIds = [...new Set(validIds)];
  const positive = testCase.expected.status === "results";
  const relevantAt = (limit) => new Set(uniqueIds.slice(0, limit).filter((id) => grades.has(id))).size;
  const visibleAt10 = uniqueIds.slice(0, 10).length;
  const ideal = [...grades.values()].sort((left, right) => right - left).slice(0, 10);
  const idealDcg = ideal.reduce((total, grade, index) => total + ((2 ** grade) - 1) / Math.log2(index + 2), 0);
  const productChecks = surface.results.map(fieldViolations);
  const hardConstraintViolations = surface.results.reduce((total, _product, index) => total
    + testCase.request.hard_constraints.filter((condition) => !satisfiesHardConstraint(productChecks[index].publicProduct, condition)).length, 0);
  const unjudged = uniqueIds.filter((id) => !poolIds.has(id));
  const violations = {
    forbidden_id_hits: uniqueIds.filter((id) => forbiddenIds.has(id)).length,
    hard_constraint_violations: hardConstraintViolations,
    duplicate_id_hits: validIds.length - new Set(validIds).size,
    invalid_result_id_hits: ids.length - validIds.length,
    unjudged_id_hits: unjudged.length,
    accessory_violations: uniqueIds.filter((id) => reasonMap.get(id)?.has("accessory_mismatch")).length,
    tenant_scope_violations: unjudged.length
      + uniqueIds.filter((id) => reasonMap.get(id)?.has("tenant_scope")).length
      + productChecks.reduce((total, check) => total + check.tenantCount, 0),
    private_field_violations: productChecks.reduce((total, check) => total + check.privateCount, 0)
      + pointerLeakCount(surface.normalized_core_payload_json_pointers),
    terminal_state_violations: Number(sourceStateViolation(surface)),
    execution_failures: Number(surface.execution_state !== "ok"),
  };
  const ranking = positive ? {
    recall_at_20: grades.size ? relevantAt(20) / grades.size : 0,
    recall_at_50: grades.size ? relevantAt(50) / grades.size : 0,
    precision_at_10: visibleAt10 ? relevantAt(10) / visibleAt10 : 0,
    ndcg_at_10: idealDcg ? dcg(uniqueIds, grades, 10) / idealDcg : 0,
  } : null;
  return {
    positive,
    ranking,
    status_match: surface.canonical_status === testCase.expected.status,
    unexpected_terminal_no_match: surface.canonical_status === "no_match" && testCase.expected.status !== "no_match",
    positive_false_no_match: surface.canonical_status === "no_match" && positive,
    known_stock_false_no_match: surface.canonical_status === "no_match" && poolCase.priority_known_stock_rank !== null,
    result_ids: uniqueIds,
    violations,
  };
}

function validateSurface(surface, adapter, requestHash, arm, surfaceName) {
  invariant(exactKeys(surface, new Set([
    "adapter_version", "adapter_source_sha256", "transport_profile", "transport_contract_sha256",
    "target_kind", "target_deployment_id_sha256", "target_config_sha256",
    "upstream_core_deployment_id_sha256", "upstream_core_config_sha256", "routing_receipt_sha256",
    "transport_contract_valid",
    "raw_transport_private_field_count", "raw_transport_sensitive_value_count", "request_canonical_sha256",
    "normalized_intent_sha256", "raw_response_sha256", "execution_state", "attempt_count",
    "source_state", "canonical_status", "results", "normalized_core_payload_json_pointers", "latency",
  ])), "PREDICTION_SURFACE_INVALID");
  const target = adapter.targets[arm];
  invariant(surface.adapter_version === adapter.version && surface.adapter_source_sha256 === adapter.source_sha256
    && surface.transport_profile === TRANSPORT_PROFILE_BY_SURFACE[surfaceName]
    && surface.transport_profile === adapter.transport_profile
    && surface.transport_contract_sha256 === adapter.transport_contract_sha256
    && surface.target_kind === target.kind
    && surface.target_deployment_id_sha256 === canonicalDigest(target.deployment_id)
    && surface.target_config_sha256 === target.config_sha256
    && surface.upstream_core_deployment_id_sha256 === target.upstream_core_deployment_id_sha256
    && surface.upstream_core_config_sha256 === target.upstream_core_config_sha256
    && surface.routing_receipt_sha256 === target.routing_receipt_sha256
    && surface.transport_contract_valid === true
    && surface.raw_transport_private_field_count === 0
    && surface.raw_transport_sensitive_value_count === 0
    && surface.request_canonical_sha256 === requestHash && SHA256.test(surface.normalized_intent_sha256)
    && SHA256.test(surface.raw_response_sha256) && EXECUTION_STATES.has(surface.execution_state)
    && surface.attempt_count === 1 && STATUSES.has(surface.canonical_status), "PREDICTION_SURFACE_INVALID");
  invariant(exactKeys(surface.source_state, new Set([
    "raw_status", "plan_complete", "scope_exhausted", "scan_limit_reached", "degraded",
  ])) && typeof surface.source_state.raw_status === "string" && surface.source_state.raw_status.length <= 80
    && ["plan_complete", "scope_exhausted", "scan_limit_reached", "degraded"]
      .every((key) => typeof surface.source_state[key] === "boolean"), "PREDICTION_SOURCE_STATE_INVALID");
  invariant(Array.isArray(surface.results) && surface.results.length <= 50, "PREDICTION_RESULTS_INVALID");
  invariant(Array.isArray(surface.normalized_core_payload_json_pointers)
    && surface.normalized_core_payload_json_pointers.length >= 1
    && surface.normalized_core_payload_json_pointers.length <= 1000
    && surface.normalized_core_payload_json_pointers.length
      === new Set(surface.normalized_core_payload_json_pointers).size
    && surface.normalized_core_payload_json_pointers.every((pointer) => typeof pointer === "string"
      && /^(?:\/(?:[^~/]|~[01])*)+$/u.test(pointer) && pointer.length <= 4096),
  "PREDICTION_POINTERS_INVALID");
  invariant(exactKeys(surface.latency, new Set(["end_to_end_ms", "retrieval_ms"]))
    && finite(surface.latency.end_to_end_ms, 0, 60_000)
    && finite(surface.latency.retrieval_ms, 0, surface.latency.end_to_end_ms), "PREDICTION_LATENCY_INVALID");
}

function validatePredictions(packet, arm, datasets, runtime, hashes) {
  invariant(exactKeys(packet, new Set([
    "schema_version", "generated_at", "arm", "capture_channel",
    "runtime_manifest_canonical_sha256", "runner", "bindings", "cases",
  ])), "PREDICTION_PACKET_INVALID");
  invariant(packet.schema_version === PREDICTION_SCHEMA && validIsoDateTime(packet.generated_at)
    && packet.arm === arm && packet.capture_channel === (arm === "legacy" ? "authoritative_legacy" : "shadow_candidate")
    && packet.runtime_manifest_canonical_sha256 === hashes.runtime, "PREDICTION_PACKET_INVALID");
  invariant(exactKeys(packet.runner, new Set(["version", "source_sha256"]))
    && packet.runner.version === runtime.capture_runner.version
    && packet.runner.source_sha256 === runtime.capture_runner.source_sha256,
  "PREDICTION_RUNNER_INVALID");
  invariant(exactKeys(packet.bindings, new Set([
    "core_canonical_sha256", "provisional_canonical_sha256", "deployment_id_sha256",
    "deployment_config_sha256", "catalog_snapshot_sha256", "index_snapshot_sha256",
    "tenant_policy_sha256", "query_packet_sha256", "pool_manifest_sha256",
  ])) && packet.bindings.core_canonical_sha256 === hashes.core
    && packet.bindings.provisional_canonical_sha256 === hashes.provisional
    && packet.bindings.deployment_id_sha256 === canonicalDigest(
      arm === "legacy" ? runtime.latency_baseline_capture.deployment_id : runtime.quality_capture.deployment_id,
    )
    && packet.bindings.deployment_config_sha256 === (arm === "legacy"
      ? runtime.latency_baseline_capture.deployment_config_sha256
      : runtime.quality_capture.deployment_config_sha256)
    && packet.bindings.catalog_snapshot_sha256 === (arm === "legacy"
      ? runtime.latency_baseline_capture.catalog_snapshot_sha256
      : runtime.quality_capture.catalog_snapshot_sha256)
    && packet.bindings.index_snapshot_sha256 === (arm === "legacy"
      ? runtime.latency_baseline_capture.index_snapshot_sha256
      : runtime.quality_capture.index_snapshot_sha256)
    && packet.bindings.tenant_policy_sha256 === (arm === "legacy"
      ? runtime.latency_baseline_capture.tenant_policy_sha256
      : runtime.quality_capture.tenant_policy_sha256)
    && packet.bindings.query_packet_sha256 === runtime.packets.query_packet_sha256
    && packet.bindings.pool_manifest_sha256 === hashes.pool, "PREDICTION_BINDING_MISMATCH");
  const expected = new Map([...datasets.core.cases, ...datasets.provisional.cases]
    .map((entry) => [entry.case_id, entry]));
  invariant(Array.isArray(packet.cases) && packet.cases.length === expected.size,
    "PREDICTION_CASE_COUNT_INVALID");
  const seen = new Set();
  const cases = new Map();
  for (const entry of packet.cases) {
    invariant(exactKeys(entry, new Set([
      "case_id", "request_canonical_sha256", "tenant_scope_sha256", "surfaces",
    ])) && CASE_ID.test(entry.case_id) && expected.has(entry.case_id) && !seen.has(entry.case_id),
    "PREDICTION_CASE_INVALID");
    const requestHash = canonicalDigest(expected.get(entry.case_id).request);
    invariant(entry.request_canonical_sha256 === requestHash && SHA256.test(entry.tenant_scope_sha256)
      && entry.tenant_scope_sha256 === packet.bindings.tenant_policy_sha256
      && exactKeys(entry.surfaces, new Set(SURFACES)), "PREDICTION_CASE_IDENTITY_MISMATCH");
    for (const surface of SURFACES) {
      validateSurface(entry.surfaces[surface], runtime.surface_adapters[surface], requestHash, arm, surface);
    }
    const intents = new Set(SURFACES.map((surface) => entry.surfaces[surface].normalized_intent_sha256));
    invariant(intents.size === 1, "PREDICTION_INTENT_MISMATCH");
    seen.add(entry.case_id);
    cases.set(entry.case_id, entry);
  }
  return cases;
}

function jaccard(left, right) {
  const leftSet = new Set(left.slice(0, 20));
  const rightSet = new Set(right.slice(0, 20));
  if (leftSet.size === 0 && rightSet.size === 0) return 1;
  const intersection = [...leftSet].filter((id) => rightSet.has(id)).length;
  return intersection / new Set([...leftSet, ...rightSet]).size;
}

export function nearestRank(values, percentile) {
  invariant(Array.isArray(values) && values.length > 0 && finite(percentile, 0, 1), "PERCENTILE_INVALID");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * percentile) - 1)];
}

function aggregateSurface(testCases, predictionCases, poolCases, surfaceName) {
  const scored = testCases.map((testCase) => scorePrivateCase(
    testCase, predictionCases.get(testCase.case_id).surfaces[surfaceName], poolCases.get(testCase.case_id),
  ));
  const ranked = scored.filter((entry) => entry.positive);
  invariant(ranked.length > 0, "SPLIT_HAS_NO_POSITIVE_CASE");
  invariant(scored.every((entry) => entry.violations.unjudged_id_hits === 0),
    "PREDICTION_OUTSIDE_JUDGMENT_POOL");
  invariant(scored.every((entry) => entry.violations.invalid_result_id_hits === 0
    && entry.violations.duplicate_id_hits === 0), "PREDICTION_RESULT_ID_MALFORMED");
  const rawMetrics = {
    recall_at_20: mean(ranked.map((entry) => entry.ranking.recall_at_20)),
    recall_at_50: mean(ranked.map((entry) => entry.ranking.recall_at_50)),
    precision_at_10: mean(ranked.map((entry) => entry.ranking.precision_at_10)),
    ndcg_at_10: mean(ranked.map((entry) => entry.ranking.ndcg_at_10)),
    status_accuracy: mean(scored.map((entry) => Number(entry.status_match))),
  };
  const metrics = {
    case_count: scored.length,
    ranked_case_count: ranked.length,
    recall_at_20: rounded(rawMetrics.recall_at_20),
    recall_at_50: rounded(rawMetrics.recall_at_50),
    precision_at_10: rounded(rawMetrics.precision_at_10),
    ndcg_at_10: rounded(rawMetrics.ndcg_at_10),
    status_accuracy: rounded(rawMetrics.status_accuracy),
    unexpected_terminal_no_match_count: scored.filter((entry) => entry.unexpected_terminal_no_match).length,
    positive_false_no_match_count: scored.filter((entry) => entry.positive_false_no_match).length,
    false_no_match_denominator: testCases.filter((entry) => entry.expected.status !== "no_match").length,
    false_no_match_rate: 0,
    known_stock_false_no_match_count: scored.filter((entry) => entry.known_stock_false_no_match).length,
  };
  const rawFalseNoMatchRate = metrics.false_no_match_denominator
    ? metrics.unexpected_terminal_no_match_count / metrics.false_no_match_denominator : 1;
  metrics.false_no_match_rate = rounded(rawFalseNoMatchRate);
  const violationKeys = Object.keys(scored[0].violations);
  const violations = Object.fromEntries(violationKeys.map((key) => [
    key, scored.reduce((total, entry) => total + entry.violations[key], 0),
  ]));
  const latencyValues = testCases.map((entry) => predictionCases.get(entry.case_id)
    .surfaces[surfaceName].latency.end_to_end_ms);
  const rawP95 = nearestRank(latencyValues, 0.95);
  const rawP99 = nearestRank(latencyValues, 0.99);
  const latency = {
    sample_count: latencyValues.length,
    p95_ms: rounded(rawP95),
    p99_ms: rounded(rawP99),
  };
  const checks = {
    recall_at_20: rawMetrics.recall_at_20 + Number.EPSILON >= PRIVATE_LIVE_GATES.minimum_recall_at_20,
    recall_at_50: rawMetrics.recall_at_50 + Number.EPSILON >= PRIVATE_LIVE_GATES.minimum_recall_at_50,
    precision_at_10: rawMetrics.precision_at_10 + Number.EPSILON >= PRIVATE_LIVE_GATES.minimum_precision_at_10,
    ndcg_at_10: rawMetrics.ndcg_at_10 + Number.EPSILON >= PRIVATE_LIVE_GATES.minimum_ndcg_at_10,
    status_accuracy: rawMetrics.status_accuracy === PRIVATE_LIVE_GATES.minimum_status_accuracy,
    false_no_match_rate: rawFalseNoMatchRate <= 0.01 + Number.EPSILON,
    known_stock_false_no_match: metrics.known_stock_false_no_match_count === 0,
    safety_violations: Object.values(violations).every((count) => count === 0),
    latency_p95: rawP95 <= 3000,
    latency_p99: rawP99 <= 5000,
  };
  return {
    metrics,
    violations,
    latency,
    absolute_surface_gate_passed: Object.values(checks).every(Boolean),
    checks,
    internal: scored,
    [RAW_METRICS]: rawMetrics,
    [RAW_LATENCY]: {
      p95_ms: rawP95,
      p99_ms: rawP99,
    },
  };
}

function aggregateSplit(testCases, predictionCases, poolCases) {
  const surfaces = Object.fromEntries(SURFACES.map((surface) => [
    surface, aggregateSurface(testCases, predictionCases, poolCases, surface),
  ]));
  const pairs = [];
  for (let left = 0; left < SURFACES.length; left += 1) {
    for (let right = left + 1; right < SURFACES.length; right += 1) {
      const leftName = SURFACES[left];
      const rightName = SURFACES[right];
      const values = testCases.map((testCase, index) => jaccard(
        surfaces[leftName].internal[index].result_ids,
        surfaces[rightName].internal[index].result_ids,
      ));
      pairs.push({ pair: `${leftName}_${rightName}`, minimum: Math.min(...values), mean: mean(values) });
    }
  }
  const statusAgreementCount = testCases.filter((testCase) => new Set(SURFACES.map((surface) => (
    predictionCases.get(testCase.case_id).surfaces[surface].canonical_status
  ))).size === 1).length;
  const crossSurface = {
    case_count: testCases.length,
    status_agreement_rate: rounded(statusAgreementCount / testCases.length),
    minimum_top_20_jaccard: rounded(Math.min(...pairs.map((entry) => entry.minimum))),
    minimum_pair_mean_top_20_jaccard: rounded(Math.min(...pairs.map((entry) => entry.mean))),
    pair_mean_top_20_jaccard: Object.fromEntries(pairs.map((entry) => [entry.pair, rounded(entry.mean)])),
    status_gate_passed: statusAgreementCount === testCases.length,
    top_20_jaccard_gate_passed: pairs.every((entry) => entry.minimum + Number.EPSILON >= 0.8),
  };
  const publicSurfaces = Object.fromEntries(SURFACES.map((surface) => {
    const { internal: _internal, ...rest } = surfaces[surface];
    return [surface, rest];
  }));
  return {
    case_count: testCases.length,
    surfaces: publicSurfaces,
    cross_surface: crossSurface,
    absolute_split_gate_passed: Object.values(publicSurfaces)
      .every((entry) => entry.absolute_surface_gate_passed)
      && crossSurface.status_gate_passed && crossSurface.top_20_jaccard_gate_passed,
  };
}

function latencyRegression(candidate, legacy) {
  invariant(legacy > 0, "LEGACY_LATENCY_BASELINE_INVALID");
  return (candidate / legacy) - 1;
}

function buildArm(splits, predictionCases, poolCases) {
  const arm = {
    training: aggregateSplit(splits.training, predictionCases, poolCases),
    hidden_holdout: aggregateSplit(splits.hidden_holdout, predictionCases, poolCases),
    provisional: aggregateSplit(splits.provisional, predictionCases, poolCases),
  };
  const overallSurfaces = Object.fromEntries(SURFACES.map((surface) => {
    const aggregates = [arm.training, arm.hidden_holdout, arm.provisional]
      .map((split) => split.surfaces[surface].metrics);
    const numerator = aggregates.reduce((total, metrics) => (
      total + metrics.unexpected_terminal_no_match_count
    ), 0);
    const denominator = aggregates.reduce((total, metrics) => (
      total + metrics.false_no_match_denominator
    ), 0);
    const knownStockCount = aggregates.reduce((total, metrics) => (
      total + metrics.known_stock_false_no_match_count
    ), 0);
    const rawRate = denominator ? numerator / denominator : 1;
    return [surface, {
      case_count: aggregates.reduce((total, metrics) => total + metrics.case_count, 0),
      unexpected_terminal_no_match_count: numerator,
      false_no_match_denominator: denominator,
      false_no_match_rate: rounded(rawRate),
      known_stock_false_no_match_count: knownStockCount,
      false_no_match_gate_passed: rawRate <= 0.01 + Number.EPSILON,
      known_stock_gate_passed: knownStockCount === 0,
    }];
  }));
  return {
    ...arm,
    overall: {
      surfaces: overallSurfaces,
      overall_false_no_match_gate_passed: Object.values(overallSurfaces)
        .every((surface) => surface.false_no_match_gate_passed && surface.known_stock_gate_passed),
    },
  };
}

function allSafetyPassed(arm) {
  return [arm.training, arm.hidden_holdout, arm.provisional].every((split) => SURFACES.every((surface) => (
    split.surfaces[surface].checks.safety_violations
      && split.surfaces[surface].checks.known_stock_false_no_match
      && split.surfaces[surface].checks.status_accuracy
      && split.surfaces[surface].checks.false_no_match_rate
      && split.cross_surface.status_gate_passed
      && split.cross_surface.top_20_jaccard_gate_passed
  )));
}

function artifactArm(arm) {
  return arm;
}

function validateCrossArmIdentity(legacyCases, candidateCases) {
  for (const [caseId, legacy] of legacyCases) {
    const candidate = candidateCases.get(caseId);
    invariant(candidate && candidate.request_canonical_sha256 === legacy.request_canonical_sha256
      && candidate.tenant_scope_sha256 === legacy.tenant_scope_sha256, "ARM_CASE_IDENTITY_MISMATCH");
    for (const surface of SURFACES) {
      invariant(candidate.surfaces[surface].normalized_intent_sha256
        === legacy.surfaces[surface].normalized_intent_sha256, "ARM_INTENT_IDENTITY_MISMATCH");
    }
  }
}

function repositoryEvidence() {
  const run = (args) => {
    const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8", shell: false });
    invariant(result.status === 0, "REPOSITORY_EVIDENCE_UNAVAILABLE");
    return result.stdout.trim();
  };
  return {
    commit: run(["rev-parse", "HEAD"]),
    working_tree_dirty: run(["status", "--porcelain", "--untracked-files=normal"]).length > 0,
  };
}

export function buildPrivatePredictionScore({
  coreDataset, provisionalDataset, holdout, agreementArtifact, poolManifest,
  legacyPredictions, candidatePredictions, runtimeManifest, repository,
}) {
  invariant(exactKeys(repository, new Set(["commit", "working_tree_dirty"]))
    && COMMIT.test(repository.commit) && typeof repository.working_tree_dirty === "boolean",
  "REPOSITORY_EVIDENCE_INVALID");
  validatePrivateDataset(coreDataset, CORE_CASE_COUNT, "CORE_DATASET");
  validatePrivateDataset(provisionalDataset, PROVISIONAL_CASE_COUNT, "PROVISIONAL_DATASET");
  const coreIds = new Set(coreDataset.cases.map((entry) => entry.case_id));
  invariant(provisionalDataset.cases.every((entry) => !coreIds.has(entry.case_id)), "DATASET_CASE_OVERLAP");
  try {
    validateHoldout(holdout, coreDataset);
  } catch {
    invariant(false, "HOLDOUT_INVALID");
  }
  const hashes = {
    core: canonicalDigest(coreDataset),
    provisional: canonicalDigest(provisionalDataset),
    holdout: canonicalDigest(holdout),
    agreement: canonicalDigest(agreementArtifact),
    pool: canonicalDigest(poolManifest),
    runtime: canonicalDigest(runtimeManifest),
    legacy: canonicalDigest(legacyPredictions),
    candidate: canonicalDigest(candidatePredictions),
  };
  validateAgreement(agreementArtifact, repository, hashes);
  validateRuntime(runtimeManifest, { hashes, pool: poolManifest }, repository);
  const expectedCatalogFixture = `private-snapshot:${runtimeManifest.quality_capture.catalog_snapshot_sha256}`;
  invariant(coreDataset.catalog_fixture === expectedCatalogFixture
    && provisionalDataset.catalog_fixture === expectedCatalogFixture, "DATASET_CATALOG_SNAPSHOT_MISMATCH");
  const fingerprints = validatePool(poolManifest, coreDataset, provisionalDataset, hashes, runtimeManifest);
  invariant(fingerprints.coreFingerprint === agreementArtifact.datasets.candidate_universe_sha256,
    "AGREEMENT_POOL_FINGERPRINT_MISMATCH");
  const datasets = { core: coreDataset, provisional: provisionalDataset };
  const legacyCases = validatePredictions(legacyPredictions, "legacy", datasets, runtimeManifest, hashes);
  const candidateCases = validatePredictions(candidatePredictions, "candidate", datasets, runtimeManifest, hashes);
  invariant(legacyPredictions.runner.version === candidatePredictions.runner.version
    && legacyPredictions.runner.source_sha256 === candidatePredictions.runner.source_sha256,
  "ARM_CAPTURE_RUNNER_MISMATCH");
  const runtimeTime = Date.parse(runtimeManifest.generated_at);
  const legacyTime = Date.parse(legacyPredictions.generated_at);
  const candidateTime = Date.parse(candidatePredictions.generated_at);
  invariant(legacyTime >= runtimeTime && candidateTime >= runtimeTime
    && Math.abs(candidateTime - legacyTime)
      <= runtimeManifest.measurement.maximum_arm_capture_skew_seconds * 1000,
  "ARM_CAPTURE_WINDOW_MISMATCH");
  validateCrossArmIdentity(legacyCases, candidateCases);
  const holdoutIds = new Set(holdout.case_ids);
  const splits = {
    training: coreDataset.cases.filter((entry) => !holdoutIds.has(entry.case_id)),
    hidden_holdout: coreDataset.cases.filter((entry) => holdoutIds.has(entry.case_id)),
    provisional: provisionalDataset.cases,
  };
  invariant(splits.training.length === TRAINING_CASE_COUNT
    && splits.hidden_holdout.length === HOLDOUT_CASE_COUNT
    && splits.provisional.length === PROVISIONAL_CASE_COUNT, "SPLIT_COUNT_INVALID");
  const poolCases = new Map(poolManifest.cases.map((entry) => [entry.case_id, entry]));
  const legacy = buildArm(splits, legacyCases, poolCases);
  const candidate = buildArm(splits, candidateCases, poolCases);

  const latencyBySplit = {};
  let maximumRegression = -Infinity;
  let latencyGate = true;
  for (const splitName of ["training", "hidden_holdout", "provisional"]) {
    latencyBySplit[splitName] = {};
    for (const surface of SURFACES) {
      const candidateP95 = candidate[splitName].surfaces[surface][RAW_LATENCY].p95_ms;
      const legacyP95 = legacy[splitName].surfaces[surface][RAW_LATENCY].p95_ms;
      const regression = latencyRegression(candidateP95, legacyP95);
      maximumRegression = Math.max(maximumRegression, regression);
      const within = regression <= 0.15 + Number.EPSILON;
      latencyGate &&= within;
      latencyBySplit[splitName][surface] = {
        legacy_p95_ms: legacyP95,
        candidate_p95_ms: candidateP95,
        regression: rounded(regression),
        regression_gate_passed: within,
      };
    }
  }

  const hiddenLegacy = legacy.hidden_holdout.surfaces.http[RAW_METRICS];
  const hiddenCandidate = candidate.hidden_holdout.surfaces.http[RAW_METRICS];
  const ndcgDelta = hiddenCandidate.ndcg_at_10 - hiddenLegacy.ndcg_at_10;
  const recallDelta = hiddenCandidate.recall_at_20 - hiddenLegacy.recall_at_20;
  let precisionNonRegression = true;
  for (const splitName of ["hidden_holdout", "provisional"]) {
    for (const surface of SURFACES) {
      precisionNonRegression &&= meetsPrecisionNonRegression(
        legacy[splitName].surfaces[surface][RAW_METRICS].precision_at_10,
        candidate[splitName].surfaces[surface][RAW_METRICS].precision_at_10,
      );
    }
  }
  const provisionalNoQualitySafetyRegression = candidate.provisional.surfaces
    && SURFACES.every((surface) => candidate.provisional.surfaces[surface][RAW_METRICS].status_accuracy
      + Number.EPSILON >= legacy.provisional.surfaces[surface][RAW_METRICS].status_accuracy
      && ["recall_at_20", "recall_at_50", "ndcg_at_10"].every((metric) => (
        candidate.provisional.surfaces[surface][RAW_METRICS][metric] + Number.EPSILON
          >= legacy.provisional.surfaces[surface][RAW_METRICS][metric]
      ))
      && Object.values(candidate.provisional.surfaces[surface].violations)
        .reduce((total, value) => total + value, 0)
      <= Object.values(legacy.provisional.surfaces[surface].violations)
        .reduce((total, value) => total + value, 0));
  const repositoryClean = repository.working_tree_dirty === false;
  const candidateAbsolute = [candidate.training, candidate.hidden_holdout, candidate.provisional]
    .every((split) => split.absolute_split_gate_passed) && latencyGate;
  const improvement = meetsShadowLift({
    ndcg_at_10: hiddenLegacy.ndcg_at_10,
    recall_at_20: hiddenLegacy.recall_at_20,
  }, {
    ndcg_at_10: hiddenCandidate.ndcg_at_10,
    recall_at_20: hiddenCandidate.recall_at_20,
  });
  const shadowRetention = repositoryClean && candidateAbsolute && allSafetyPassed(candidate)
    && improvement && precisionNonRegression && provisionalNoQualitySafetyRegression;
  const legacySafe = repositoryClean && allSafetyPassed(legacy);
  const recommendation = shadowRetention
    ? "retain_candidate_for_further_shadow"
    : (legacySafe ? "keep_legacy_authoritative" : "no_safe_baseline_manual_escalation");

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    provenance: "private_live_aggregate_only",
    runner: { version: RUNNER_VERSION, source_sha256: RUNNER_SOURCE_SHA256 },
    repository,
    inputs: {
      runtime_manifest_sha256: hashes.runtime,
      agreement_artifact_sha256: hashes.agreement,
      pool_manifest_sha256: hashes.pool,
      core_sha256: hashes.core,
      provisional_sha256: hashes.provisional,
      holdout_sha256: hashes.holdout,
      legacy_predictions_sha256: hashes.legacy,
      candidate_predictions_sha256: hashes.candidate,
    },
    runtime_identity: {
      root_worker_commit: runtimeManifest.release.root_worker_commit,
      deployment_id_sha256: canonicalDigest(runtimeManifest.quality_capture.deployment_id),
      deployment_config_sha256: runtimeManifest.quality_capture.deployment_config_sha256,
      latency_baseline_deployment_id_sha256: canonicalDigest(runtimeManifest.latency_baseline_capture.deployment_id),
      latency_baseline_config_sha256: runtimeManifest.latency_baseline_capture.deployment_config_sha256,
      latency_baseline_index_snapshot_sha256: runtimeManifest.latency_baseline_capture.index_snapshot_sha256,
      agent_core_contract_commit: runtimeManifest.release.agent_core_commit,
      agent_core_search_contract_sha256: runtimeManifest.release.agent_core_search_contract_sha256,
      catalog_snapshot_sha256: runtimeManifest.quality_capture.catalog_snapshot_sha256,
      index_snapshot_sha256: runtimeManifest.quality_capture.index_snapshot_sha256,
      tenant_policy_sha256: runtimeManifest.quality_capture.tenant_policy_sha256,
      deployed_field_policy_sha256: runtimeManifest.quality_capture.deployed_field_policy_sha256,
      scorer_required_allowlist_sha256: runtimeManifest.quality_capture.scorer_required_allowlist_sha256,
      capture_runner_source_sha256: runtimeManifest.capture_runner.source_sha256,
      surface_capture_manifest_sha256: canonicalDigest(runtimeManifest.surface_adapters),
      measurement_protocol_sha256: canonicalDigest(runtimeManifest.measurement),
    },
    datasets: {
      training_count: TRAINING_CASE_COUNT,
      hidden_count: HOLDOUT_CASE_COUNT,
      provisional_count: PROVISIONAL_CASE_COUNT,
      known_stock_count: PRIORITY_KNOWN_STOCK_COUNT,
      core_candidate_universe_sha256: fingerprints.coreFingerprint,
      provisional_candidate_universe_sha256: fingerprints.provisionalFingerprint,
    },
    arms: { legacy: artifactArm(legacy), candidate: artifactArm(candidate) },
    latency_comparison: {
      splits: latencyBySplit,
      maximum_p95_regression: rounded(maximumRegression),
      latency_regression_gate_passed: latencyGate,
    },
    shadow_comparison: {
      selection_split: "hidden_holdout",
      selection_surface: "http",
      ndcg_at_10_delta: rounded(ndcgDelta),
      recall_at_20_delta: rounded(recallDelta),
      precision_non_regression_gate_passed: precisionNonRegression,
      provisional_quality_safety_non_regression_gate_passed: provisionalNoQualitySafetyRegression,
      improvement_gate_passed: improvement,
      recommendation,
    },
    gates: {
      all_inputs_consistent: true,
      repository_clean: repositoryClean,
      offline_prediction_score_passed: repositoryClean && candidateAbsolute && allSafetyPassed(candidate),
      shadow_retention_criteria_passed: shadowRetention,
    },
    boundaries: {
      contains_case_ids: false,
      contains_queries: false,
      contains_product_ids: false,
      contains_results: false,
      contains_labels: false,
      contains_paths: false,
      contains_credentials: false,
      contains_responses: false,
      contains_urls: false,
      uses_public_eval: false,
      agreement_used_as_predictions: false,
      scores_four_surfaces: true,
      generalizes_beyond_judgment_pool: false,
      executes_search: false,
      authorizes_search_rollout: false,
      authorizes_release: false,
      authorizes_live_preview: false,
      authorizes_product_write: false,
    },
  };
}

function argument(args, name) {
  const index = args.indexOf(name);
  invariant(index >= 0 && args[index + 1] && !args[index + 1].startsWith("--"), "PRIVATE_SCORE_ARGUMENT_MISSING");
  return args[index + 1];
}

function inside(parent, child) {
  const normalize = (value) => process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
  const relative = path.relative(normalize(parent), normalize(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function secureReadInputs(files) {
  const physicalRoot = await realpath(repositoryRoot);
  const loadedFiles = [];
  let total = 0;
  const identities = new Set();
  for (const [name, config] of Object.entries(files)) {
    const lexical = path.resolve(config.file);
    invariant(!inside(repositoryRoot, lexical), "PRIVATE_SCORE_INPUT_INSIDE_REPOSITORY");
    const physical = await realpath(lexical);
    invariant(!inside(physicalRoot, physical), "PRIVATE_SCORE_INPUT_INSIDE_REPOSITORY");
    const handle = await open(physical, "r");
    try {
      const before = await handle.stat({ bigint: true });
      const openedPath = await stat(physical, { bigint: true });
      invariant(before.isFile() && before.nlink === 1n && openedPath.nlink === 1n
        && sameFileIdentity(before, openedPath) && before.size <= BigInt(config.maximum),
        "PRIVATE_SCORE_INPUT_FILE_INVALID");
      const identity = `${before.dev}:${before.ino}`;
      invariant(!identities.has(identity), "PRIVATE_SCORE_INPUT_ALIAS");
      identities.add(identity);
      total += Number(before.size);
      invariant(total <= MAX_TOTAL_INPUT_BYTES, "PRIVATE_SCORE_INPUT_TOTAL_TOO_LARGE");
      const bytes = await handle.readFile();
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        invariant(false, "PRIVATE_SCORE_INPUT_UTF8_INVALID");
      }
      const after = await handle.stat({ bigint: true });
      const afterPath = await stat(physical, { bigint: true });
      invariant(sameFileIdentity(before, after) && sameFileIdentity(before, afterPath)
        && after.nlink === 1n && afterPath.nlink === 1n
        && before.size === after.size && before.size === afterPath.size
        && before.mtimeNs === after.mtimeNs && before.mtimeNs === afterPath.mtimeNs
        && await realpath(lexical) === physical,
      "PRIVATE_SCORE_INPUT_CHANGED_DURING_READ");
      loadedFiles.push([name, { value: parseStrictJson(text), physical }]);
    } finally {
      await handle.close();
    }
  }
  return {
    values: Object.fromEntries(loadedFiles.map(([name, item]) => [name, item.value])),
    physical: loadedFiles.map(([, item]) => item.physical),
    physicalRoot,
  };
}

function artifactDenylistCheck(artifact) {
  const serialized = JSON.stringify(artifact);
  invariant(!/(?:"[A-Za-z0-9]{22}"|https?:\/\/|[A-Za-z]:\\|\\\\[^"\\]+\\|\/(?:Users|home|tmp)\/)/u.test(serialized),
    "PRIVATE_SCORE_ARTIFACT_NOT_SANITIZED");
}

export async function runCli(args = process.argv.slice(2), options = {}) {
  const output = path.resolve(argument(args, "--output"));
  const files = {
    coreDataset: { file: argument(args, "--core"), maximum: MAX_DATA_INPUT_BYTES },
    provisionalDataset: { file: argument(args, "--provisional"), maximum: MAX_DATA_INPUT_BYTES },
    holdout: { file: argument(args, "--holdout"), maximum: MAX_SMALL_INPUT_BYTES },
    agreementArtifact: { file: argument(args, "--agreement"), maximum: MAX_SMALL_INPUT_BYTES },
    poolManifest: { file: argument(args, "--pool"), maximum: MAX_DATA_INPUT_BYTES },
    runtimeManifest: { file: argument(args, "--runtime-manifest"), maximum: MAX_SMALL_INPUT_BYTES },
    legacyPredictions: { file: argument(args, "--legacy"), maximum: MAX_PREDICTION_INPUT_BYTES },
    candidatePredictions: { file: argument(args, "--candidate"), maximum: MAX_PREDICTION_INPUT_BYTES },
  };
  const loaded = await secureReadInputs(files);
  const logicalInside = inside(repositoryRoot, output);
  if (logicalInside) invariant(inside(path.join(repositoryRoot, "build", "private-eval-score"), output),
    "PRIVATE_SCORE_OUTPUT_LOCATION_INVALID");
  invariant(!Object.values(files).some((entry) => path.resolve(entry.file) === output), "PRIVATE_SCORE_OUTPUT_ALIASES_INPUT");
  await mkdir(path.dirname(output), { recursive: true });
  const physicalParent = await realpath(path.dirname(output));
  if (inside(loaded.physicalRoot, physicalParent)) {
    const physicalBuild = await realpath(path.join(repositoryRoot, "build"));
    invariant(inside(physicalBuild, physicalParent), "PRIVATE_SCORE_OUTPUT_LOCATION_INVALID");
    const ignored = spawnSync("git", ["check-ignore", "-q", output], { cwd: repositoryRoot, shell: false });
    invariant(ignored.status === 0, "PRIVATE_SCORE_OUTPUT_NOT_IGNORED");
  }
  const targetPhysical = path.join(physicalParent, path.basename(output));
  invariant(!loaded.physical.includes(targetPhysical), "PRIVATE_SCORE_OUTPUT_ALIASES_INPUT");
  const repository = options.repository || repositoryEvidence();
  const artifact = buildPrivatePredictionScore({ ...loaded.values, repository });
  artifactDenylistCheck(artifact);
  let outputIdentity = null;
  try {
    // Open the already-resolved physical target, not the lexical path whose
    // parent junction could be exchanged after validation.
    const handle = await open(targetPhysical, "wx", 0o600);
    try {
      const created = await handle.stat({ bigint: true });
      invariant(created.isFile() && created.nlink === 1n, "PRIVATE_SCORE_OUTPUT_FILE_INVALID");
      outputIdentity = { dev: created.dev, ino: created.ino };
      const createdPath = await realpath(targetPhysical);
      const createdViaPath = await stat(targetPhysical, { bigint: true });
      invariant(samePath(createdPath, targetPhysical)
        && sameFileIdentity(created, createdViaPath), "PRIVATE_SCORE_OUTPUT_IDENTITY_MISMATCH");
      await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      await handle.sync();
      const afterHandle = await handle.stat({ bigint: true });
      const afterPath = await stat(targetPhysical, { bigint: true });
      invariant(sameFileIdentity(created, afterHandle) && sameFileIdentity(created, afterPath)
        && afterHandle.nlink === 1n && samePath(await realpath(targetPhysical), targetPhysical),
      "PRIVATE_SCORE_OUTPUT_CHANGED_DURING_WRITE");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (outputIdentity) {
      try {
        const current = await stat(targetPhysical, { bigint: true });
        if (sameFileIdentity(outputIdentity, current)
          && samePath(await realpath(targetPhysical), targetPhysical)) {
          await rm(targetPhysical, { force: true });
        }
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          // Never delete a path whose identity is uncertain. Preserve the
          // original fixed-code failure and leave incident cleanup to a human.
        }
      }
    }
    throw error;
  }
  const label = artifact.gates.shadow_retention_criteria_passed ? "PASS" : "BLOCKED";
  process.stdout.write(`${label}: PRIVATE_SCORE_AGGREGATE_ONLY; rollout remains unauthorized.\n`);
  if (label === "BLOCKED") process.exitCode = 2;
  return artifact;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch(() => {
    process.stderr.write("BLOCKED: PRIVATE_SCORE_VALIDATION_FAILED; no private input details were emitted.\n");
    process.exitCode = 2;
  });
}
