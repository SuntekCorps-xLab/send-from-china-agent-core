import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AGENT_CORE_SEARCH_CONTRACT_SHA256,
  buildPrivatePredictionScore,
  canonicalDigest,
  meetsPrecisionNonRegression,
  meetsShadowLift,
  nearestRank,
  parseStrictJson,
  PUBLIC_FIELD_ALLOWLIST_SHA256,
  runCli,
  scorePrivateCase,
} from "../score.mjs";
import { buildPrivateEvalGate } from "../../private-gate/adjudicate.mjs";
import { PRIVATE_LIVE_GATES } from "../../v0/dataset.mjs";

const CORE_CASE_COUNT = 120;
const HOLDOUT_CASE_COUNT = 30;
const PROVISIONAL_CASE_COUNT = 180;
const PRIORITY_KNOWN_STOCK_COUNT = 200;
const SURFACES = ["http", "mcp", "chat", "storefront"];
const TRANSPORT_PROFILES = {
  http: "search_v2_http",
  mcp: "mcp_jsonrpc_tools_call",
  chat: "mini_chat_bff",
  storefront: "reference_storefront_bff",
};
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const SHA_F = "f".repeat(64);
const AGENT_CORE_COMMIT = "c".repeat(40);
const ROOT_WORKER_COMMIT = "d".repeat(40);

function publicId(prefix, value) {
  return `${prefix}${String(value).padStart(21, "0")}`;
}

function idsFor(globalIndex) {
  return {
    positives: Array.from({ length: 10 }, (_, slot) => publicId("P", (globalIndex * 100) + slot)),
    negatives: Array.from({ length: 3 }, (_, slot) => publicId("N", (globalIndex * 100) + slot)),
  };
}

function evalCase(globalIndex, cohort) {
  const caseId = `${cohort}_case_${String(globalIndex).padStart(3, "0")}`;
  const noMatch = globalIndex % 23 === 7;
  const { positives, negatives } = idsFor(globalIndex);
  const grades = [3, 3, 2, 2, 2, 1, 1, 1, 1, 1];
  const localIndex = cohort === "core" ? globalIndex : globalIndex - CORE_CASE_COUNT;
  const suites = ["full"];
  if (localIndex < 8) suites.push("smoke");
  if (localIndex === 0) suites.push("security");
  return {
    case_id: caseId,
    suites,
    request: {
      contract_version: "2.0",
      product_identity: {
        name: "product_identity",
        value: `synthetic private scoring query ${globalIndex}`,
        source: "explicit",
        scope: "product",
        hardness: "hard",
      },
      hard_constraints: [{
        name: "price_max",
        value: 40,
        source: "explicit",
        scope: "product",
        hardness: "hard",
      }],
      soft_context: [],
      transaction_context: [],
      limit: 50,
      cursor: null,
    },
    expected: {
      status: noMatch ? "no_match" : "results",
      relevance: noMatch
        ? []
        : positives.map((id, position) => ({ public_id: id, grade: grades[position] })),
      forbidden_ids: [negatives[0]],
    },
  };
}

function dataset(count, cohort, offset) {
  return {
    dataset_version: `private-${cohort}-score-v1`,
    schema_version: "send-from-china-eval-dataset/v0",
    provenance: "private_live",
    generated_at: "2026-08-27T00:00:00.000Z",
    catalog_fixture: `private-snapshot:${SHA_A}`,
    description: "Generated contract fixture; it contains no production or customer data.",
    limitations: [
      "The records in this test are synthetic and are not production relevance evidence.",
      "A real private run still requires frozen captures and approved independent labels.",
    ],
    gates: { ...PRIVATE_LIVE_GATES },
    cases: Array.from({ length: count }, (_, index) => evalCase(index + offset, cohort)),
  };
}

function candidateIds(testCase) {
  const match = /_(\d+)$/u.exec(testCase.case_id);
  assert.ok(match);
  const globalIndex = Number(match[1]);
  const { positives, negatives } = idsFor(globalIndex);
  return [...positives, ...negatives];
}

function reviewPacket(coreDataset, reviewerCharacter) {
  return {
    schema_version: "send-from-china-eval-review/v1",
    dataset_version: coreDataset.dataset_version,
    reviewer_id_hash: reviewerCharacter.repeat(64),
    cases: coreDataset.cases.map((entry) => {
      const grades = new Map(entry.expected.relevance.map((item) => [item.public_id, item.grade]));
      return {
        case_id: entry.case_id,
        status: entry.expected.status,
        candidates: candidateIds(entry).map((id) => ({ public_id: id, grade: grades.get(id) || 0 })),
        forbidden_ids: [...entry.expected.forbidden_ids],
      };
    }),
  };
}

function candidateUniverseFingerprint(cases) {
  return canonicalDigest(cases
    .map((entry) => ({
      case_id: entry.case_id,
      candidate_ids: [...entry.candidate_ids].sort(),
    }))
    .sort((left, right) => left.case_id.localeCompare(right.case_id)));
}

function poolSource(sourceId, lane, topK, revision, model = null) {
  return {
    source_id: sourceId,
    lane,
    top_k: topK,
    config_sha256: canonicalDigest({ sourceId, lane, topK }),
    model_revision: revision,
    model_config_sha256: model?.config_sha256 || null,
    model_identity_sha256: model ? canonicalDigest(model) : null,
    index_revision_sha256: canonicalDigest({ sourceId, revision }),
  };
}

function makePool(coreDataset, provisionalDataset, priorityRanks) {
  const embeddingModel = {
    role: "embedding",
    provider_model_id: "@cf/baai/bge-m3",
    revision: "test-revision-v1",
    config_sha256: SHA_F,
  };
  const cases = [...coreDataset.cases, ...provisionalDataset.cases].map((entry) => {
    const ids = candidateIds(entry);
    const priorityRank = priorityRanks.get(entry.case_id) || null;
    return {
      case_id: entry.case_id,
      dataset: entry.case_id.startsWith("core_") ? "core" : "provisional",
      priority_known_stock_rank: priorityRank,
      known_stock_evidence_sha256: priorityRank === null
        ? null
        : canonicalDigest({ case_id: entry.case_id, evidence: "synthetic-known-stock" }),
      known_stock_evidence_catalog_snapshot_sha256: priorityRank === null ? null : SHA_A,
      candidate_ids: ids,
      forbidden_reason_labels: [{
        public_id: entry.expected.forbidden_ids[0],
        reasons: [Number(/_(\d+)$/u.exec(entry.case_id)[1]) % 2 === 0
          ? "accessory_mismatch"
          : "tenant_scope"],
      }],
    };
  });
  const recipe = {
    frozen_before_annotation: true,
    candidate_config_frozen_before_pool: true,
    blinded_source_and_rank: true,
    dedupe_key: "public_id",
    max_candidates_per_case: 500,
    presentation_seed_sha256: SHA_B,
    sources: [
      poolSource("legacy", "legacy", 100, "legacy-v1"),
      poolSource("meili", "meili_lexical", 100, "meili-v1"),
      poolSource("dense", "bge_vector", 50, embeddingModel.revision, embeddingModel),
      poolSource("aliases", "alias", 50, "aliases-v1"),
      poolSource("shopify", "shopify_fallback", 50, "shopify-v1"),
      poolSource("known-positive", "known_positive", 50, "review-v1"),
      poolSource("approved-negative", "approved_negative", 50, "review-v1"),
    ],
  };
  const coreCases = cases.filter((entry) => entry.dataset === "core");
  const provisionalCases = cases.filter((entry) => entry.dataset === "provisional");
  return {
    schema_version: "send-from-china-private-pool/v1",
    generated_at: "2026-08-27T00:05:00.000Z",
    pool_recipe_version: "private-pooled-judgment-v1",
    recipe,
    datasets: {
      core_canonical_sha256: canonicalDigest(coreDataset),
      provisional_canonical_sha256: canonicalDigest(provisionalDataset),
      catalog_snapshot_sha256: SHA_A,
      index_snapshot_sha256: SHA_B,
      tenant_policy_sha256: SHA_C,
    },
    cases,
    fingerprints: {
      core_candidate_universe_sha256: candidateUniverseFingerprint(coreCases),
      provisional_candidate_universe_sha256: candidateUniverseFingerprint(provisionalCases),
    },
    approval: {
      known_positive_negative_receipt_sha256: SHA_C,
      provisional_label_approval_sha256: SHA_D,
    },
  };
}

function product(publicIdValue, testCase) {
  return {
    public_id: publicIdValue,
    slug: `synthetic-${publicIdValue.toLowerCase()}`,
    title: "Synthetic cotton organizer",
    description: "A generated product used only to verify an offline scorer.",
    category: "organizers",
    tags: ["synthetic", "cotton"],
    attributes: { material: "cotton", color: "green" },
    price: { amount: 30, currency: "USD" },
    availability_band: "in_stock",
    lead_time_days: 5,
    as_of: "2026-08-27T00:00:00.000Z",
    purchasable: false,
  };
}

function rankedProducts(testCase, quality) {
  if (testCase.expected.status !== "results") return [];
  const ids = testCase.expected.relevance.map((entry) => entry.public_id);
  if (quality === "legacy") [ids[1], ids[2]] = [ids[2], ids[1]];
  return ids.map((id) => product(id, testCase));
}

function sourceState(status) {
  return {
    raw_status: status,
    plan_complete: status === "no_match" || status === "results",
    scope_exhausted: status === "no_match",
    scan_limit_reached: false,
    degraded: false,
  };
}

function capturedSurface(testCase, arm, adapter, latencyMs, quality = arm) {
  const status = testCase.expected.status;
  const results = rankedProducts(testCase, quality);
  const target = adapter.targets[arm];
  return {
    adapter_version: adapter.version,
    adapter_source_sha256: adapter.source_sha256,
    transport_profile: adapter.transport_profile,
    transport_contract_sha256: adapter.transport_contract_sha256,
    target_kind: target.kind,
    target_deployment_id_sha256: canonicalDigest(target.deployment_id),
    target_config_sha256: target.config_sha256,
    upstream_core_deployment_id_sha256: target.upstream_core_deployment_id_sha256,
    upstream_core_config_sha256: target.upstream_core_config_sha256,
    routing_receipt_sha256: target.routing_receipt_sha256,
    transport_contract_valid: true,
    raw_transport_private_field_count: 0,
    raw_transport_sensitive_value_count: 0,
    request_canonical_sha256: canonicalDigest(testCase.request),
    normalized_intent_sha256: canonicalDigest({
      identity: testCase.request.product_identity,
      constraints: testCase.request.hard_constraints,
    }),
    raw_response_sha256: canonicalDigest({ transport: adapter.transport_profile, status, results }),
    execution_state: "ok",
    attempt_count: 1,
    source_state: sourceState(status),
    canonical_status: status,
    results,
    normalized_core_payload_json_pointers: ["/status", "/results"],
    latency: {
      end_to_end_ms: latencyMs,
      retrieval_ms: Math.floor(latencyMs * 0.7),
    },
  };
}

function deploymentCapture(runtimeManifest, arm) {
  return arm === "legacy"
    ? runtimeManifest.latency_baseline_capture
    : runtimeManifest.quality_capture;
}

function predictionPacket({
  arm,
  coreDataset,
  provisionalDataset,
  holdout,
  agreementArtifact,
  poolManifest,
  runtimeManifest,
  quality = arm,
  latencyMs = arm === "legacy" ? 1000 : 950,
}) {
  const capture = deploymentCapture(runtimeManifest, arm);
  return {
    schema_version: "send-from-china-private-predictions/v1",
    generated_at: "2026-08-27T00:15:00.000Z",
    arm,
    capture_channel: arm === "legacy" ? "authoritative_legacy" : "shadow_candidate",
    runtime_manifest_canonical_sha256: canonicalDigest(runtimeManifest),
    runner: { ...runtimeManifest.capture_runner },
    bindings: {
      core_canonical_sha256: canonicalDigest(coreDataset),
      provisional_canonical_sha256: canonicalDigest(provisionalDataset),
      deployment_id_sha256: canonicalDigest(capture.deployment_id),
      deployment_config_sha256: capture.deployment_config_sha256,
      catalog_snapshot_sha256: capture.catalog_snapshot_sha256,
      index_snapshot_sha256: capture.index_snapshot_sha256,
      tenant_policy_sha256: runtimeManifest.quality_capture.tenant_policy_sha256,
      query_packet_sha256: runtimeManifest.packets.query_packet_sha256,
      pool_manifest_sha256: canonicalDigest(poolManifest),
    },
    cases: [...coreDataset.cases, ...provisionalDataset.cases].map((entry) => ({
      case_id: entry.case_id,
      request_canonical_sha256: canonicalDigest(entry.request),
      tenant_scope_sha256: runtimeManifest.quality_capture.tenant_policy_sha256,
      surfaces: Object.fromEntries(SURFACES.map((surfaceName) => [
        surfaceName,
        capturedSurface(
          entry,
          arm,
          runtimeManifest.surface_adapters[surfaceName],
          latencyMs,
          quality,
        ),
      ])),
    })),
  };
}

function makeFixture() {
  const coreDataset = dataset(CORE_CASE_COUNT, "core", 0);
  const provisionalDataset = dataset(PROVISIONAL_CASE_COUNT, "provisional", CORE_CASE_COUNT);
  const holdout = {
    schema_version: "send-from-china-eval-holdout/v1",
    dataset_version: coreDataset.dataset_version,
    case_ids: coreDataset.cases.slice(-HOLDOUT_CASE_COUNT).map((entry) => entry.case_id),
  };
  const resultCases = [...coreDataset.cases, ...provisionalDataset.cases]
    .filter((entry) => entry.expected.status === "results");
  assert.ok(resultCases.length >= PRIORITY_KNOWN_STOCK_COUNT);
  const priorityRanks = new Map(resultCases
    .slice(0, PRIORITY_KNOWN_STOCK_COUNT)
    .map((entry, index) => [entry.case_id, index + 1]));
  const poolManifest = makePool(coreDataset, provisionalDataset, priorityRanks);
  const agreementArtifact = buildPrivateEvalGate({
    coreDataset,
    provisionalDataset,
    holdout,
    reviewerA: reviewPacket(coreDataset, "a"),
    reviewerB: reviewPacket(coreDataset, "b"),
    repository: { commit: AGENT_CORE_COMMIT, working_tree_dirty: false },
  });
  assert.equal(
    agreementArtifact.datasets.candidate_universe_sha256,
    poolManifest.fingerprints.core_candidate_universe_sha256,
  );
  const deploymentCaptures = {
    legacy: {
      deployment_id: "l".repeat(32),
      deployment_config_sha256: canonicalDigest({ fusion: "legacy", rerank: "off" }),
    },
    candidate: {
      deployment_id: "q".repeat(32),
      deployment_config_sha256: canonicalDigest({ fusion: "rrf", rerank: "shadow" }),
    },
  };
  const surfaceAdapters = Object.fromEntries(SURFACES.map((name, index) => [name, {
    version: `${name}-adapter-v1`,
    source_sha256: canonicalDigest({ name, index }),
    transport_profile: TRANSPORT_PROFILES[name],
    transport_contract_sha256: canonicalDigest({ profile: TRANSPORT_PROFILES[name], version: 1 }),
    targets: Object.fromEntries(["legacy", "candidate"].map((arm) => {
      const core = deploymentCaptures[arm];
      const directCore = ["http", "mcp"].includes(name);
      return [arm, {
        kind: directCore ? "direct_core" : "bff",
        deployment_id: directCore ? core.deployment_id : `${arm}-${name}`.padEnd(32, "0"),
        config_sha256: directCore
          ? core.deployment_config_sha256
          : canonicalDigest({ name, arm, layer: "bff" }),
        upstream_core_deployment_id_sha256: canonicalDigest(core.deployment_id),
        upstream_core_config_sha256: core.deployment_config_sha256,
        routing_receipt_sha256: canonicalDigest({
          name, arm, core: core.deployment_id, config: core.deployment_config_sha256,
        }),
      }];
    })),
  }]));
  const runtimeManifest = {
    schema_version: "send-from-china-private-runtime-manifest/v1",
    generated_at: "2026-08-27T00:10:00.000Z",
    environment: "isolated_shadow",
    release: {
      mini_suntek_commit: "a".repeat(40),
      agent_core_commit: AGENT_CORE_COMMIT,
      agent_core_search_contract_sha256: AGENT_CORE_SEARCH_CONTRACT_SHA256,
      reference_store_commit: "b".repeat(40),
      root_worker_commit: ROOT_WORKER_COMMIT,
      root_worker_working_tree_dirty: false,
    },
    capture_runner: {
      version: "private-black-box-capture-v1",
      source_sha256: SHA_E,
    },
    measurement: {
      warmup_requests_per_surface: 5,
      warmups_excluded_from_metrics: true,
      measured_attempts_per_case: 1,
      schedule: "seeded_arm_interleave",
      schedule_seed_sha256: SHA_D,
      maximum_arm_capture_skew_seconds: 3600,
      timeout_ms: 5000,
      timeout_samples_retained: true,
      clock: "monotonic",
    },
    quality_capture: {
      deployment_id: deploymentCaptures.candidate.deployment_id,
      deployment_config_sha256: deploymentCaptures.candidate.deployment_config_sha256,
      catalog_snapshot_sha256: SHA_A,
      index_snapshot_sha256: SHA_B,
      tenant_policy_sha256: SHA_C,
      deployed_field_policy_sha256: SHA_F,
      scorer_required_allowlist_sha256: PUBLIC_FIELD_ALLOWLIST_SHA256,
      hard_constraint_evaluator_sha256: SHA_D,
      request_packet_sha256: SHA_E,
      candidate_retrieval_recipe_sha256: canonicalDigest(poolManifest.recipe),
      authoritative_selector: "legacy",
      shadow_selector: "rrf",
    },
    latency_baseline_capture: {
      deployment_id: deploymentCaptures.legacy.deployment_id,
      deployment_config_sha256: deploymentCaptures.legacy.deployment_config_sha256,
      catalog_snapshot_sha256: SHA_A,
      index_snapshot_sha256: SHA_B,
      tenant_policy_sha256: SHA_C,
      request_packet_sha256: SHA_E,
      fusion_mode: "legacy",
      rerank_mode: "off",
      evidence_rag_mode: "off",
    },
    datasets: {
      core_canonical_sha256: canonicalDigest(coreDataset),
      provisional_canonical_sha256: canonicalDigest(provisionalDataset),
      holdout_canonical_sha256: canonicalDigest(holdout),
      agreement_artifact_sha256: canonicalDigest(agreementArtifact),
    },
    pool: {
      pool_recipe_version: poolManifest.pool_recipe_version,
      pool_recipe_sha256: canonicalDigest(poolManifest.recipe),
      pool_manifest_sha256: canonicalDigest(poolManifest),
    },
    surface_adapters: surfaceAdapters,
    models: [{
      role: "embedding",
      provider_model_id: "@cf/baai/bge-m3",
      revision: "test-revision-v1",
      config_sha256: SHA_F,
    }],
    packets: {
      query_packet_sha256: SHA_E,
      agent_task_packet_sha256: SHA_D,
      adversarial_packet_sha256: SHA_C,
    },
    boundaries: {
      production_writes_enabled: false,
      live_invites_activated: false,
      raw_query_logging_enabled: false,
      retry_policy: "none",
    },
  };
  const repository = { commit: AGENT_CORE_COMMIT, working_tree_dirty: false };
  const common = {
    coreDataset,
    provisionalDataset,
    holdout,
    agreementArtifact,
    poolManifest,
    runtimeManifest,
    repository,
  };
  return {
    ...common,
    legacyPredictions: predictionPacket({ ...common, arm: "legacy" }),
    candidatePredictions: predictionPacket({ ...common, arm: "candidate" }),
  };
}

let frozenFixture;

function fixture() {
  frozenFixture ||= makeFixture();
  return structuredClone(frozenFixture);
}

function findCase(inputs, predicate = (entry) => entry.expected.status === "results") {
  const testCase = [...inputs.coreDataset.cases, ...inputs.provisionalDataset.cases].find(predicate);
  assert.ok(testCase);
  const poolCase = inputs.poolManifest.cases.find((entry) => entry.case_id === testCase.case_id);
  assert.ok(poolCase);
  return { testCase, poolCase };
}

function capturedCase(packet, caseId) {
  const entry = packet.cases.find((item) => item.case_id === caseId);
  assert.ok(entry);
  return entry;
}

function replaceResponse(surface, status, results, sourceStateOverride = {}) {
  surface.canonical_status = status;
  surface.results = results;
  surface.source_state = { ...surface.source_state, ...sourceStateOverride };
  surface.raw_response_sha256 = canonicalDigest({ status, results });
}

function rebindPool(inputs) {
  const poolHash = canonicalDigest(inputs.poolManifest);
  inputs.runtimeManifest.pool.pool_manifest_sha256 = poolHash;
  for (const packet of [inputs.legacyPredictions, inputs.candidatePredictions]) {
    packet.bindings.pool_manifest_sha256 = poolHash;
  }
  const runtimeHash = canonicalDigest(inputs.runtimeManifest);
  for (const packet of [inputs.legacyPredictions, inputs.candidatePredictions]) {
    packet.runtime_manifest_canonical_sha256 = runtimeHash;
  }
}

test("canonical digests and nearest-rank percentiles are deterministic", () => {
  assert.equal(canonicalDigest({ b: 2, a: [1, { y: false, x: null }] }),
    canonicalDigest({ a: [1, { x: null, y: false }], b: 2 }));
  assert.match(canonicalDigest({ synthetic: true }), /^[0-9a-f]{64}$/u);
  const values = Array.from({ length: 20 }, (_, index) => index + 1).reverse();
  assert.equal(nearestRank(values, 0.95), 19);
  assert.equal(nearestRank(values, 0.99), 20);
  assert.deepEqual(values, Array.from({ length: 20 }, (_, index) => 20 - index));
  assert.throws(() => nearestRank([], 0.95), /PERCENTILE_INVALID/u);
});

test("Shadow lift and precision thresholds compare raw values at exact boundaries", () => {
  assert.equal(meetsShadowLift(
    { ndcg_at_10: 0.8, recall_at_20: 0.9 },
    { ndcg_at_10: 0.83, recall_at_20: 0.9 },
  ), true);
  assert.equal(meetsShadowLift(
    { ndcg_at_10: 0.8, recall_at_20: 0.9 },
    { ndcg_at_10: 0.8, recall_at_20: 0.92 },
  ), true);
  assert.equal(meetsShadowLift(
    { ndcg_at_10: 0.8, recall_at_20: 0.9 },
    { ndcg_at_10: 0.829999, recall_at_20: 0.919999 },
  ), false);
  assert.equal(meetsPrecisionNonRegression(0.86, 0.85), true);
  assert.equal(meetsPrecisionNonRegression(0.86, 0.849999), false);
});

test("strict private JSON parsing rejects duplicate object keys", () => {
  const parsed = parseStrictJson('{"arm":"legacy","cases":[]}');
  assert.equal(parsed.arm, "legacy");
  assert.deepEqual(parsed.cases, []);
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.throws(
    () => parseStrictJson('{"arm":"legacy","arm":"candidate"}'),
    /PRIVATE_SCORE_DUPLICATE_JSON_KEY/u,
  );
  assert.throws(() => parseStrictJson("\u00a0{}"), /PRIVATE_SCORE_JSON_INVALID/u);
  assert.throws(
    () => parseStrictJson(`${"[".repeat(130)}0${"]".repeat(130)}`),
    /PRIVATE_SCORE_JSON_NESTING_EXCEEDED/u,
  );
});

test("a complete 120/30/180 four-surface capture passes and emits aggregate-only evidence", () => {
  const inputs = fixture();
  const artifact = buildPrivatePredictionScore(inputs);
  assert.equal(artifact.gates.offline_prediction_score_passed, true);
  assert.equal(artifact.gates.shadow_retention_criteria_passed, true);
  for (const arm of ["legacy", "candidate"]) {
    assert.equal(artifact.arms[arm].overall.overall_false_no_match_gate_passed, true);
    for (const surface of SURFACES) {
      assert.equal(artifact.arms[arm].overall.surfaces[surface].case_count, 300);
      assert.equal(artifact.arms[arm].overall.surfaces[surface].false_no_match_rate, 0);
    }
  }
  assert.equal(artifact.arms.candidate.training.cross_surface.status_gate_passed, true);
  assert.equal(artifact.arms.candidate.hidden_holdout.cross_surface.top_20_jaccard_gate_passed, true);
  assert.equal(artifact.latency_comparison.latency_regression_gate_passed, true);
  assert.deepEqual({
    training: artifact.datasets.training_count,
    hidden_holdout: artifact.datasets.hidden_count,
    provisional: artifact.datasets.provisional_count,
    priority_known_stock: artifact.datasets.known_stock_count,
  }, {
    training: CORE_CASE_COUNT - HOLDOUT_CASE_COUNT,
    hidden_holdout: HOLDOUT_CASE_COUNT,
    provisional: PROVISIONAL_CASE_COUNT,
    priority_known_stock: PRIORITY_KNOWN_STOCK_COUNT,
  });
  assert.equal(artifact.boundaries.contains_case_ids, false);
  assert.equal(artifact.boundaries.contains_queries, false);
  assert.equal(artifact.boundaries.contains_product_ids, false);
  assert.equal(artifact.boundaries.contains_responses, false);
  assert.equal(artifact.boundaries.contains_paths, false);
  assert.equal(artifact.boundaries.executes_search, false);
  assert.equal(artifact.boundaries.authorizes_search_rollout, false);
  assert.equal(artifact.boundaries.authorizes_release, false);

  const serialized = JSON.stringify(artifact);
  for (const forbidden of [
    inputs.coreDataset.cases[0].case_id,
    inputs.coreDataset.cases[0].request.product_identity.value,
    inputs.coreDataset.cases[0].expected.relevance[0].public_id,
    inputs.runtimeManifest.quality_capture.deployment_id,
    inputs.runtimeManifest.latency_baseline_capture.deployment_id,
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("zero-positive no-match cases do not manufacture recall, precision or NDCG", () => {
  const inputs = fixture();
  const { testCase, poolCase } = findCase(inputs, (entry) => entry.expected.status === "no_match");
  const surface = capturedCase(inputs.candidatePredictions, testCase.case_id).surfaces.http;
  const scored = scorePrivateCase(testCase, surface, poolCase);
  assert.equal(scored.positive, false);
  assert.equal(scored.ranking, null);
  assert.equal(scored.status_match, true);
  assert.equal(scored.unexpected_terminal_no_match, false);
  assert.deepEqual(scored.violations, {
    forbidden_id_hits: 0,
    hard_constraint_violations: 0,
    duplicate_id_hits: 0,
    invalid_result_id_hits: 0,
    unjudged_id_hits: 0,
    accessory_violations: 0,
    tenant_scope_violations: 0,
    private_field_violations: 0,
    terminal_state_violations: 0,
    execution_failures: 0,
  });
});

test("Top-10 NDCG limits IDCG to ten ideal results", () => {
  const inputs = fixture();
  const { testCase, poolCase } = findCase(inputs);
  const extraId = publicId("X", 999999);
  testCase.expected.relevance.push({ public_id: extraId, grade: 1 });
  poolCase.candidate_ids.push(extraId);
  const surface = capturedCase(inputs.candidatePredictions, testCase.case_id).surfaces.http;
  const scored = scorePrivateCase(testCase, surface, poolCase);
  assert.equal(scored.ranking.ndcg_at_10, 1);
  assert.equal(scored.ranking.precision_at_10, 1);
  assert.equal(scored.ranking.recall_at_20, 10 / 11);
});

test("a positive gold case with no returned results receives four explicit zero ranking metrics", () => {
  const inputs = fixture();
  const { testCase, poolCase } = findCase(inputs);
  const surface = structuredClone(capturedCase(inputs.candidatePredictions, testCase.case_id).surfaces.http);
  replaceResponse(surface, "results", []);
  const scored = scorePrivateCase(testCase, surface, poolCase);
  assert.deepEqual(scored.ranking, {
    recall_at_20: 0,
    recall_at_50: 0,
    precision_at_10: 0,
    ndcg_at_10: 0,
  });
  assert.equal(scored.violations.terminal_state_violations, 1);
});

test("hard-constraint token matching does not treat red as a substring of recycled", () => {
  const inputs = fixture();
  const { testCase, poolCase } = findCase(inputs);
  testCase.request.hard_constraints = [{
    name: "material",
    value: "red",
    source: "explicit",
    scope: "product",
    hardness: "hard",
  }];
  const surface = structuredClone(capturedCase(inputs.candidatePredictions, testCase.case_id).surfaces.http);
  const recycled = product(testCase.expected.relevance[0].public_id, testCase);
  recycled.attributes.material = "recycled polyester";
  replaceResponse(surface, "results", [recycled]);
  const scored = scorePrivateCase(testCase, surface, poolCase);
  assert.equal(scored.violations.hard_constraint_violations, 1);
});

test("unjudged, forbidden, hard-constraint and private-field output fails closed", () => {
  const inputs = fixture();
  const { testCase, poolCase } = findCase(inputs, (entry) => entry.expected.status === "results"
    && Number(/_(\d+)$/u.exec(entry.case_id)[1]) % 2 === 0);
  const surface = structuredClone(capturedCase(inputs.candidatePredictions, testCase.case_id).surfaces.http);
  const forbidden = product(testCase.expected.forbidden_ids[0], testCase);
  const hardViolation = product(testCase.expected.relevance[0].public_id, testCase);
  hardViolation.price.amount = 99;
  const privateProjection = product(testCase.expected.relevance[1].public_id, testCase);
  privateProjection.internal_note = "must-never-cross-the-public-boundary";
  privateProjection.attributes.supplier_id = "private-supplier";
  privateProjection.attributes.supplierId = "camel-private-supplier";
  privateProjection.attributes.apiToken = "camel-private-token";
  const unjudged = product(publicId("U", 999999), testCase);
  replaceResponse(surface, "results", [forbidden, hardViolation, privateProjection, unjudged]);
  surface.normalized_core_payload_json_pointers.push(
    "/results/2/attributes/supplierId",
    "/results/2/warehouse_code",
    "/debug/internalTrace",
  );

  const scored = scorePrivateCase(testCase, surface, poolCase);
  assert.equal(scored.violations.forbidden_id_hits, 1);
  assert.ok(scored.violations.hard_constraint_violations >= 1);
  assert.equal(scored.violations.unjudged_id_hits, 1);
  assert.ok(scored.violations.private_field_violations >= 1);
  assert.equal(scored.violations.accessory_violations, 1);
  assert.equal(JSON.stringify(scored).includes("private-supplier"), false);
  assert.equal(JSON.stringify(scored).includes("camel-private-token"), false);
  assert.equal(JSON.stringify(scored).includes("must-never-cross-the-public-boundary"), false);
});

test("each unapproved credential, PII and identifier attribute fails closed in isolation", () => {
  for (const key of [
    "accessToken", "clientSecret", "password", "authorization", "cookie",
    "customerEmail", "customerPhone", "shippingAddress", "supplierReferenceId",
    "imageUrl", "futurePublicLookingField",
  ]) {
    const inputs = fixture();
    const { testCase, poolCase } = findCase(inputs);
    const surface = structuredClone(capturedCase(
      inputs.candidatePredictions, testCase.case_id,
    ).surfaces.http);
    const unsafe = product(testCase.expected.relevance[0].public_id, testCase);
    unsafe.attributes[key] = "must-not-cross";
    replaceResponse(surface, "results", [unsafe]);
    surface.normalized_core_payload_json_pointers.push(`/results/0/attributes/${key}`);
    const scored = scorePrivateCase(testCase, surface, poolCase);
    assert.ok(scored.violations.private_field_violations >= 1, key);
    assert.equal(JSON.stringify(scored).includes("must-not-cross"), false, key);
  }
});

test("JSON Pointer percent escapes remain literal and cannot impersonate approved fields", () => {
  for (const pointer of ["/%73tatus", "/results/0/%74itle"]) {
    const inputs = fixture();
    const { testCase, poolCase } = findCase(inputs);
    const surface = structuredClone(capturedCase(
      inputs.candidatePredictions, testCase.case_id,
    ).surfaces.http);
    surface.normalized_core_payload_json_pointers = [pointer, "/results"];
    const scored = scorePrivateCase(testCase, surface, poolCase);
    assert.ok(scored.violations.private_field_violations >= 1, pointer);
  }
});

test("credential, PII and internal-host values fail closed even in approved public fields", () => {
  for (const [field, value] of [
    ["description", "Contact customer@example.invalid for access"],
    ["description", ["Author", "ization: Bear", "er abcdefghijklmnopqrstuvwxyz"].join("")],
    ["description", ["api", "_key=abcdefghijklmnop"].join("")],
    ["description", "token eyJabcdefghijk.abcdefghijkl.abcdefghijkl"],
    ["image", ["https://10", "0", "0", "7/private.png"].join(".")],
    ["image", ["https://169", "254", "169", "254/latest/meta-data/x.png"].join(".")],
    ["image", ["https://100", "64", "0", "1/private.png"].join(".")],
    ["image", ["https://0", "0", "0", "0/private.png"].join(".")],
    ["image", ["https://[fd", "00::1]/private.png"].join("")],
    ["image", ["https://[fe", "80::1]/private.png"].join("")],
  ]) {
    const inputs = fixture();
    const { testCase, poolCase } = findCase(inputs);
    const surface = structuredClone(capturedCase(
      inputs.candidatePredictions, testCase.case_id,
    ).surfaces.http);
    const unsafe = product(testCase.expected.relevance[0].public_id, testCase);
    if (field === "image") unsafe.images = [{ url: value, alt: "unsafe" }];
    else unsafe[field] = value;
    replaceResponse(surface, "results", [unsafe]);
    const scored = scorePrivateCase(testCase, surface, poolCase);
    assert.ok(scored.violations.private_field_violations >= 1, value);
    assert.equal(JSON.stringify(scored).includes(value), false, value);
  }
});

test("Schema-level title, date and HTTPS URL semantics are enforced at runtime", () => {
  for (const mutate of [
    (unsafe) => { unsafe.title = "   "; },
    (unsafe) => { unsafe.as_of = "2026-02-30T00:00:00Z"; },
    (unsafe) => { unsafe.images = [{ url: "https://", alt: "invalid" }]; },
    (unsafe) => { unsafe.images = [{ url: "https://user:pass@example.invalid/a.png", alt: "credentials" }]; },
  ]) {
    const inputs = fixture();
    const { testCase, poolCase } = findCase(inputs);
    const surface = structuredClone(capturedCase(
      inputs.candidatePredictions, testCase.case_id,
    ).surfaces.http);
    const unsafe = product(testCase.expected.relevance[0].public_id, testCase);
    mutate(unsafe);
    replaceResponse(surface, "results", [unsafe]);
    const scored = scorePrivateCase(testCase, surface, poolCase);
    assert.ok(scored.violations.private_field_violations >= 1);
  }
});

test("false no-match and degraded terminal no-match are independently blocked", () => {
  const inputs = fixture();
  const { testCase, poolCase } = findCase(inputs, (entry) => entry.expected.status === "results"
    && inputs.poolManifest.cases.find((item) => item.case_id === entry.case_id)?.priority_known_stock_rank === 1);
  const surface = structuredClone(capturedCase(inputs.candidatePredictions, testCase.case_id).surfaces.http);
  replaceResponse(surface, "no_match", [], {
    plan_complete: true,
    scope_exhausted: true,
    scan_limit_reached: false,
  });
  let scored = scorePrivateCase(testCase, surface, poolCase);
  assert.equal(scored.positive_false_no_match, true);
  assert.equal(scored.known_stock_false_no_match, true);

  replaceResponse(surface, "no_match", [], {
    plan_complete: true,
    scope_exhausted: true,
    scan_limit_reached: false,
    degraded: true,
  });
  scored = scorePrivateCase(testCase, surface, poolCase);
  assert.equal(scored.violations.terminal_state_violations, 1);
  assert.equal(scored.positive_false_no_match, true);

  const providerFailure = structuredClone(capturedCase(
    inputs.candidatePredictions, testCase.case_id,
  ).surfaces.http);
  providerFailure.source_state = {
    raw_status: "provider_timeout",
    plan_complete: false,
    scope_exhausted: false,
    scan_limit_reached: true,
    degraded: true,
  };
  scored = scorePrivateCase(testCase, providerFailure, poolCase);
  assert.equal(scored.violations.terminal_state_violations, 1);
});

test("degraded and clarification statuses require truthful source-state mappings", () => {
  const inputs = fixture();
  const { testCase, poolCase } = findCase(inputs);
  const baseSurface = structuredClone(capturedCase(
    inputs.candidatePredictions, testCase.case_id,
  ).surfaces.http);

  const degradedCase = structuredClone(testCase);
  degradedCase.expected = { status: "degraded", relevance: [], forbidden_ids: [] };
  replaceResponse(baseSurface, "degraded", [], {
    raw_status: "provider_timeout",
    plan_complete: false,
    scope_exhausted: false,
    scan_limit_reached: false,
    degraded: true,
  });
  let scored = scorePrivateCase(degradedCase, baseSurface, poolCase);
  assert.equal(scored.status_match, true);
  assert.equal(scored.violations.terminal_state_violations, 0);
  replaceResponse(baseSurface, "degraded", [product(
    testCase.expected.relevance[0].public_id, testCase,
  )], {
    raw_status: "provider_timeout",
    plan_complete: false,
    scope_exhausted: false,
    scan_limit_reached: false,
    degraded: true,
  });
  scored = scorePrivateCase(degradedCase, baseSurface, poolCase);
  assert.equal(scored.violations.terminal_state_violations, 1);
  replaceResponse(baseSurface, "degraded", [], {
    raw_status: "provider_timeout",
    plan_complete: false,
    scope_exhausted: false,
    scan_limit_reached: false,
    degraded: true,
  });
  baseSurface.source_state = { ...baseSurface.source_state, raw_status: "results", degraded: false };
  scored = scorePrivateCase(degradedCase, baseSurface, poolCase);
  assert.equal(scored.violations.terminal_state_violations, 1);

  const clarificationCase = structuredClone(testCase);
  clarificationCase.expected = { status: "needs_clarification", relevance: [], forbidden_ids: [] };
  replaceResponse(baseSurface, "needs_clarification", [], {
    raw_status: "needs_clarification",
    plan_complete: false,
    scope_exhausted: false,
    scan_limit_reached: false,
    degraded: false,
  });
  scored = scorePrivateCase(clarificationCase, baseSurface, poolCase);
  assert.equal(scored.status_match, true);
  assert.equal(scored.violations.terminal_state_violations, 0);
  replaceResponse(baseSurface, "needs_clarification", [product(
    testCase.expected.relevance[0].public_id, testCase,
  )], {
    raw_status: "needs_clarification",
    plan_complete: false,
    scope_exhausted: false,
    scan_limit_reached: false,
    degraded: false,
  });
  scored = scorePrivateCase(clarificationCase, baseSurface, poolCase);
  assert.equal(scored.violations.terminal_state_violations, 1);
  replaceResponse(baseSurface, "needs_clarification", [], {
    raw_status: "needs_clarification",
    plan_complete: false,
    scope_exhausted: false,
    scan_limit_reached: false,
    degraded: false,
  });
  baseSurface.source_state.raw_status = "provider_timeout";
  scored = scorePrivateCase(clarificationCase, baseSurface, poolCase);
  assert.equal(scored.violations.terminal_state_violations, 1);
});

test("four surfaces must agree on canonical status and materially overlap", () => {
  const statusInputs = fixture();
  for (const entry of statusInputs.candidatePredictions.cases) {
    if (entry.surfaces.storefront.canonical_status !== "results") continue;
    replaceResponse(entry.surfaces.storefront, "no_match", [], {
      plan_complete: true,
      scope_exhausted: true,
      scan_limit_reached: false,
    });
  }
  const statusArtifact = buildPrivatePredictionScore(statusInputs);
  assert.equal(statusArtifact.arms.candidate.training.cross_surface.status_gate_passed, false);
  assert.equal(statusArtifact.arms.candidate.hidden_holdout.cross_surface.status_gate_passed, false);
  assert.equal(statusArtifact.gates.offline_prediction_score_passed, false);

  const overlapInputs = fixture();
  for (const entry of overlapInputs.candidatePredictions.cases) {
    if (entry.surfaces.storefront.canonical_status !== "results") continue;
    const poolCase = overlapInputs.poolManifest.cases.find((item) => item.case_id === entry.case_id);
    const disjoint = poolCase.candidate_ids.slice(-3).map((id) => {
      const datasetCase = [...overlapInputs.coreDataset.cases, ...overlapInputs.provisionalDataset.cases]
        .find((item) => item.case_id === entry.case_id);
      return product(id, datasetCase);
    });
    replaceResponse(entry.surfaces.storefront, "results", disjoint);
  }
  const overlapArtifact = buildPrivatePredictionScore(overlapInputs);
  assert.equal(overlapArtifact.arms.candidate.training.cross_surface.status_gate_passed, true);
  assert.equal(overlapArtifact.arms.candidate.training.cross_surface.top_20_jaccard_gate_passed, false);
  assert.equal(overlapArtifact.gates.offline_prediction_score_passed, false);
});

test("nearest-rank p95/p99 and relative p95 regression are release gates", () => {
  const exactInputs = fixture();
  for (const entry of exactInputs.candidatePredictions.cases) {
    for (const surface of Object.values(entry.surfaces)) {
      surface.latency.end_to_end_ms = 1150;
      surface.latency.retrieval_ms = 800;
    }
  }
  const exactArtifact = buildPrivatePredictionScore(exactInputs);
  assert.equal(exactArtifact.latency_comparison.maximum_p95_regression, 0.15);
  assert.equal(exactArtifact.latency_comparison.latency_regression_gate_passed, true);

  const roundingInputs = fixture();
  for (const entry of roundingInputs.candidatePredictions.cases) {
    for (const surface of Object.values(entry.surfaces)) {
      surface.latency.end_to_end_ms = 3000.0000004;
      surface.latency.retrieval_ms = 2000;
    }
  }
  const roundingArtifact = buildPrivatePredictionScore(roundingInputs);
  assert.equal(roundingArtifact.arms.candidate.training.surfaces.http.latency.p95_ms, 3000);
  assert.equal(roundingArtifact.arms.candidate.training.surfaces.http.checks.latency_p95, false);
  assert.equal(roundingArtifact.gates.offline_prediction_score_passed, false);

  const inputs = fixture();
  for (const entry of inputs.candidatePredictions.cases) {
    for (const surface of Object.values(entry.surfaces)) {
      surface.latency.end_to_end_ms = 1201;
      surface.latency.retrieval_ms = 800;
    }
  }
  const relativeArtifact = buildPrivatePredictionScore(inputs);
  assert.equal(relativeArtifact.arms.candidate.training.surfaces.http.checks.latency_p95, true);
  assert.equal(relativeArtifact.arms.candidate.training.surfaces.http.checks.latency_p99, true);
  assert.equal(relativeArtifact.latency_comparison.latency_regression_gate_passed, false);
  assert.equal(relativeArtifact.gates.offline_prediction_score_passed, false);

  const slowInputs = fixture();
  for (let index = 0; index < slowInputs.candidatePredictions.cases.length; index += 1) {
    for (const surface of Object.values(slowInputs.candidatePredictions.cases[index].surfaces)) {
      surface.latency.end_to_end_ms = index < 285 ? 2900 : 5100;
      surface.latency.retrieval_ms = 2000;
    }
  }
  const absoluteArtifact = buildPrivatePredictionScore(slowInputs);
  assert.equal(absoluteArtifact.arms.candidate.provisional.surfaces.http.checks.latency_p99, false);
  assert.equal(absoluteArtifact.gates.offline_prediction_score_passed, false);
});

test("Shadow retention is selected only from hidden holdout plus provisional quality", () => {
  const trainingOnly = fixture();
  const hidden = new Set(trainingOnly.holdout.case_ids);
  for (const entry of trainingOnly.candidatePredictions.cases) {
    const isDecisionCase = hidden.has(entry.case_id) || entry.case_id.startsWith("provisional_");
    if (!isDecisionCase) continue;
    const legacyCase = capturedCase(trainingOnly.legacyPredictions, entry.case_id);
    for (const surfaceName of SURFACES) {
      entry.surfaces[surfaceName] = structuredClone(legacyCase.surfaces[surfaceName]);
      entry.surfaces[surfaceName].adapter_version = trainingOnly.runtimeManifest.surface_adapters[surfaceName].version;
      entry.surfaces[surfaceName].adapter_source_sha256 = trainingOnly.runtimeManifest.surface_adapters[surfaceName].source_sha256;
      entry.surfaces[surfaceName].transport_profile = trainingOnly.runtimeManifest
        .surface_adapters[surfaceName].transport_profile;
      entry.surfaces[surfaceName].transport_contract_sha256 = trainingOnly.runtimeManifest
        .surface_adapters[surfaceName].transport_contract_sha256;
      entry.surfaces[surfaceName].target_deployment_id_sha256 = canonicalDigest(
        trainingOnly.runtimeManifest.surface_adapters[surfaceName].targets.candidate.deployment_id,
      );
      entry.surfaces[surfaceName].target_config_sha256 = trainingOnly.runtimeManifest
        .surface_adapters[surfaceName].targets.candidate.config_sha256;
      entry.surfaces[surfaceName].target_kind = trainingOnly.runtimeManifest
        .surface_adapters[surfaceName].targets.candidate.kind;
      entry.surfaces[surfaceName].upstream_core_deployment_id_sha256 = trainingOnly.runtimeManifest
        .surface_adapters[surfaceName].targets.candidate.upstream_core_deployment_id_sha256;
      entry.surfaces[surfaceName].upstream_core_config_sha256 = trainingOnly.runtimeManifest
        .surface_adapters[surfaceName].targets.candidate.upstream_core_config_sha256;
      entry.surfaces[surfaceName].routing_receipt_sha256 = trainingOnly.runtimeManifest
        .surface_adapters[surfaceName].targets.candidate.routing_receipt_sha256;
    }
  }
  const trainingOnlyArtifact = buildPrivatePredictionScore(trainingOnly);
  assert.equal(trainingOnlyArtifact.gates.offline_prediction_score_passed, true);
  assert.equal(trainingOnlyArtifact.gates.shadow_retention_criteria_passed, false);

  const decisionImprovement = fixture();
  const decisionArtifact = buildPrivatePredictionScore(decisionImprovement);
  assert.equal(decisionArtifact.gates.offline_prediction_score_passed, true);
  assert.equal(decisionArtifact.gates.shadow_retention_criteria_passed, true);

  const provisionalRegression = fixture();
  const provisionalCase = provisionalRegression.candidatePredictions.cases.find((entry) => (
    entry.case_id.startsWith("provisional_") && entry.surfaces.http.results.length === 10
  ));
  assert.ok(provisionalCase);
  for (const surfaceName of SURFACES) {
    const surface = provisionalCase.surfaces[surfaceName];
    replaceResponse(surface, "results", surface.results.slice(0, 9));
  }
  const provisionalRegressionArtifact = buildPrivatePredictionScore(provisionalRegression);
  assert.equal(provisionalRegressionArtifact.gates.offline_prediction_score_passed, true);
  assert.equal(
    provisionalRegressionArtifact.shadow_comparison
      .provisional_quality_safety_non_regression_gate_passed,
    false,
  );
  assert.equal(provisionalRegressionArtifact.gates.shadow_retention_criteria_passed, false);
});

test("identity bindings, exact cardinality and 200 known-stock ranks cannot drift", () => {
  const wrongCommit = fixture();
  wrongCommit.runtimeManifest.release.agent_core_commit = "e".repeat(40);
  assert.throws(() => buildPrivatePredictionScore(wrongCommit), /agreement|commit|identity|runtime/iu);

  const missingPrediction = fixture();
  missingPrediction.candidatePredictions.cases.pop();
  assert.throws(() => buildPrivatePredictionScore(missingPrediction), /300|case[_ ]count|cardinality|missing/iu);

  const badPriorityRank = fixture();
  const ranked = badPriorityRank.poolManifest.cases.find((entry) => entry.priority_known_stock_rank === 200);
  ranked.priority_known_stock_rank = null;
  ranked.known_stock_evidence_sha256 = null;
  ranked.known_stock_evidence_catalog_snapshot_sha256 = null;
  rebindPool(badPriorityRank);
  assert.throws(() => buildPrivatePredictionScore(badPriorityRank), /200|priority|known.stock/iu);

  const staleKnownStockEvidence = fixture();
  const staleRanked = staleKnownStockEvidence.poolManifest.cases
    .find((entry) => entry.priority_known_stock_rank === 1);
  staleRanked.known_stock_evidence_catalog_snapshot_sha256 = SHA_F;
  rebindPool(staleKnownStockEvidence);
  assert.throws(() => buildPrivatePredictionScore(staleKnownStockEvidence), /known.stock|evidence|snapshot/iu);

  const mismatchedPool = fixture();
  mismatchedPool.runtimeManifest.pool.pool_manifest_sha256 = SHA_F;
  assert.throws(() => buildPrivatePredictionScore(mismatchedPool), /pool|digest|hash|identity/iu);

  const mismatchedRecipe = fixture();
  mismatchedRecipe.runtimeManifest.quality_capture.candidate_retrieval_recipe_sha256 = SHA_F;
  assert.throws(() => buildPrivatePredictionScore(mismatchedRecipe), /pool|recipe|binding|runtime/iu);

  const unapprovedRunner = fixture();
  unapprovedRunner.candidatePredictions.runner.source_sha256 = SHA_F;
  assert.throws(() => buildPrivatePredictionScore(unapprovedRunner), /runner/iu);

  const forgedAgreementRunner = fixture();
  forgedAgreementRunner.agreementArtifact.runner.source_sha256 = SHA_F;
  forgedAgreementRunner.runtimeManifest.datasets.agreement_artifact_sha256 = canonicalDigest(
    forgedAgreementRunner.agreementArtifact,
  );
  assert.throws(() => buildPrivatePredictionScore(forgedAgreementRunner), /agreement|runner/iu);

  const wrongSurfaceTarget = fixture();
  wrongSurfaceTarget.candidatePredictions.cases[0].surfaces.chat.target_config_sha256 = SHA_F;
  assert.throws(() => buildPrivatePredictionScore(wrongSurfaceTarget), /surface|target|prediction/iu);

  const wrongUpstreamReceipt = fixture();
  wrongUpstreamReceipt.candidatePredictions.cases[0].surfaces.storefront
    .upstream_core_deployment_id_sha256 = SHA_F;
  assert.throws(() => buildPrivatePredictionScore(wrongUpstreamReceipt), /surface|target|prediction/iu);

  const detachedDirectTarget = fixture();
  detachedDirectTarget.runtimeManifest.surface_adapters.http.targets.candidate.deployment_id = "x".repeat(32);
  const detachedRuntimeHash = canonicalDigest(detachedDirectTarget.runtimeManifest);
  for (const packet of [detachedDirectTarget.legacyPredictions, detachedDirectTarget.candidatePredictions]) {
    packet.runtime_manifest_canonical_sha256 = detachedRuntimeHash;
  }
  assert.throws(() => buildPrivatePredictionScore(detachedDirectTarget), /runtime|surface|target/iu);

  const invalidTransport = fixture();
  invalidTransport.candidatePredictions.cases[0].surfaces.mcp.transport_contract_valid = false;
  assert.throws(() => buildPrivatePredictionScore(invalidTransport), /surface|transport|prediction/iu);

  const transportValueLeak = fixture();
  transportValueLeak.candidatePredictions.cases[0].surfaces.chat.raw_transport_sensitive_value_count = 1;
  assert.throws(() => buildPrivatePredictionScore(transportValueLeak), /surface|transport|prediction/iu);

  const captureWindowDrift = fixture();
  captureWindowDrift.candidatePredictions.generated_at = "2026-08-27T02:15:00.000Z";
  assert.throws(() => buildPrivatePredictionScore(captureWindowDrift), /capture|window/iu);

  const invalidRuntimeDate = fixture();
  invalidRuntimeDate.runtimeManifest.generated_at = "2026-02-30T00:00:00Z";
  const invalidDateRuntimeHash = canonicalDigest(invalidRuntimeDate.runtimeManifest);
  for (const packet of [invalidRuntimeDate.legacyPredictions, invalidRuntimeDate.candidatePredictions]) {
    packet.runtime_manifest_canonical_sha256 = invalidDateRuntimeHash;
  }
  assert.throws(() => buildPrivatePredictionScore(invalidRuntimeDate), /runtime|manifest|date/iu);

  const missingEmbedding = fixture();
  missingEmbedding.runtimeManifest.models = [{
    role: "intent",
    provider_model_id: "@cf/baai/bge-m3",
    revision: "test-revision-v1",
    config_sha256: SHA_F,
  }];
  assert.throws(() => buildPrivatePredictionScore(missingEmbedding), /model/iu);

  const missingReranker = fixture();
  missingReranker.runtimeManifest.quality_capture.shadow_selector = "rrf_reranker";
  assert.throws(() => buildPrivatePredictionScore(missingReranker), /model/iu);

  const mismatchedEmbedding = fixture();
  mismatchedEmbedding.runtimeManifest.models[0].revision = "another-embedding-revision";
  const mismatchedRuntimeHash = canonicalDigest(mismatchedEmbedding.runtimeManifest);
  for (const packet of [mismatchedEmbedding.legacyPredictions, mismatchedEmbedding.candidatePredictions]) {
    packet.runtime_manifest_canonical_sha256 = mismatchedRuntimeHash;
  }
  assert.throws(() => buildPrivatePredictionScore(mismatchedEmbedding), /pool|embedding|model/iu);

  const mismatchedEmbeddingProvider = fixture();
  mismatchedEmbeddingProvider.runtimeManifest.models[0].provider_model_id = "@cf/other/embedding-model";
  const mismatchedProviderRuntimeHash = canonicalDigest(mismatchedEmbeddingProvider.runtimeManifest);
  for (const packet of [
    mismatchedEmbeddingProvider.legacyPredictions,
    mismatchedEmbeddingProvider.candidatePredictions,
  ]) packet.runtime_manifest_canonical_sha256 = mismatchedProviderRuntimeHash;
  assert.throws(() => buildPrivatePredictionScore(mismatchedEmbeddingProvider), /pool|embedding|model/iu);
});

test("a dirty scorer checkout cannot produce a passing offline or Shadow gate", () => {
  const inputs = fixture();
  inputs.repository.working_tree_dirty = true;
  const artifact = buildPrivatePredictionScore(inputs);
  assert.equal(artifact.gates.repository_clean, false);
  assert.equal(artifact.gates.offline_prediction_score_passed, false);
  assert.equal(artifact.gates.shadow_retention_criteria_passed, false);
});

test("all private scorer Schemas parse and lock aggregate-only boundaries", async () => {
  const schemas = {};
  for (const file of [
    "runtime-manifest.schema.json",
    "pool.schema.json",
    "predictions.schema.json",
    "artifact.schema.json",
  ]) {
    const schema = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
    assert.equal(schema.additionalProperties, false);
    schemas[file] = schema;
  }
  const inputs = fixture();
  const values = {
    "runtime-manifest.schema.json": inputs.runtimeManifest,
    "pool.schema.json": inputs.poolManifest,
    "predictions.schema.json": inputs.candidatePredictions,
    "artifact.schema.json": buildPrivatePredictionScore(inputs),
  };
  for (const [file, value] of Object.entries(values)) {
    const expected = [...schemas[file].required].sort();
    assert.deepEqual(Object.keys(value).sort(), expected, `${file} required keys drifted from runtime output`);
    assert.deepEqual(Object.keys(schemas[file].properties).sort(), expected,
      `${file} property keys drifted from its required keys`);
  }
  const artifactSchema = schemas["artifact.schema.json"];
  const boundaryProperties = artifactSchema.properties.boundaries.properties;
  for (const field of [
    "contains_case_ids",
    "contains_queries",
    "contains_product_ids",
    "contains_results",
    "contains_responses",
    "contains_paths",
    "executes_search",
    "authorizes_search_rollout",
    "authorizes_release",
  ]) {
    assert.equal(boundaryProperties[field].const, false);
  }
  const runtimeSchema = schemas["runtime-manifest.schema.json"];
  assert.equal(runtimeSchema.properties.models.minItems, 1);
  assert.equal(runtimeSchema.properties.models.maxItems, 3);
  assert.equal(runtimeSchema.$defs.opaqueId.minLength, 32);
  assert.equal(runtimeSchema.$defs.opaqueId.maxLength, 128);
  assert.equal(runtimeSchema.$defs.version.pattern, "^[A-Za-z0-9][A-Za-z0-9._\\-]{0,79}$");
  assert.equal(runtimeSchema.$defs.modelIdentifier.pattern,
    "^[A-Za-z0-9@][A-Za-z0-9._:@/+\\-]{0,199}$");
  for (const file of [
    "runtime-manifest.schema.json", "pool.schema.json", "predictions.schema.json",
    "artifact.schema.json",
  ]) {
    assert.equal(schemas[file].$defs.version.pattern,
      "^[A-Za-z0-9][A-Za-z0-9._\\-]{0,79}$", file);
  }
  const pointerSchema = schemas["predictions.schema.json"].$defs.surfaceResult.properties
    .normalized_core_payload_json_pointers;
  assert.equal(pointerSchema.minItems, 1);
  assert.equal(pointerSchema.maxItems, 1000);
  assert.equal(pointerSchema.items.maxLength, 4096);
  assert.equal(pointerSchema.items.pattern, "^(?:/(?:[^~/]|~[01])*)+$");
  const publicAttributePolicy = JSON.parse(await readFile(
    new URL("../../../contracts/public-product-attribute-policy.v1.json", import.meta.url), "utf8",
  ));
  assert.equal(
    schemas["predictions.schema.json"].$defs.publicProduct.properties.attributes.propertyNames.$ref,
    "../../contracts/public-product-attribute-policy.v1.json",
  );
  assert.equal(publicAttributePolicy.schema_version, "public-product-attributes/v1");
  assert.equal(publicAttributePolicy.enum.length, 61);
});

test("the CLI consumes only external captures and writes a new sanitized artifact", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "private-prediction-score-"));
  try {
    const inputs = fixture();
    const values = {
      core: inputs.coreDataset,
      provisional: inputs.provisionalDataset,
      holdout: inputs.holdout,
      agreement: inputs.agreementArtifact,
      pool: inputs.poolManifest,
      runtime: inputs.runtimeManifest,
      legacy: inputs.legacyPredictions,
      candidate: inputs.candidatePredictions,
    };
    const files = {};
    for (const [name, value] of Object.entries(values)) {
      files[name] = path.join(directory, `${name}.json`);
      await writeFile(files[name], JSON.stringify(value), "utf8");
    }
    const output = path.join(directory, "aggregate-artifact.json");
    const args = [
      "--core", files.core,
      "--provisional", files.provisional,
      "--holdout", files.holdout,
      "--agreement", files.agreement,
      "--pool", files.pool,
      "--runtime-manifest", files.runtime,
      "--legacy", files.legacy,
      "--candidate", files.candidate,
      "--output", output,
    ];
    const artifact = await runCli(args, { repository: inputs.repository });
    assert.equal(artifact.gates.offline_prediction_score_passed, true);
    const serialized = await readFile(output, "utf8");
    assert.equal(serialized.includes(inputs.coreDataset.cases[0].case_id), false);
    assert.equal(serialized.includes(inputs.coreDataset.cases[0].request.product_identity.value), false);
    assert.equal(serialized.includes(inputs.coreDataset.cases[0].expected.relevance[0].public_id), false);
    assert.equal(serialized.includes(inputs.runtimeManifest.quality_capture.deployment_id), false);
    await assert.rejects(runCli(args, { repository: inputs.repository }), (error) => error?.code === "EEXIST");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
