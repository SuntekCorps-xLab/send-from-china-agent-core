const SUITES = new Set(["smoke", "full", "security", "perf"]);
const STATUSES = new Set(["results", "needs_clarification", "no_match", "degraded"]);
const HARD_CONSTRAINTS = new Set(["price_min", "price_max", "material", "color", "must_have", "exclude"]);
const GATE_FIELDS = new Set([
  "minimum_recall_at_20", "minimum_recall_at_50", "minimum_precision_at_10",
  "minimum_ndcg_at_10", "minimum_status_accuracy", "maximum_forbidden_id_hits",
  "maximum_hard_constraint_violations", "maximum_duplicate_id_hits",
]);

function assert(condition, message) {
  if (!condition) throw new TypeError(`Invalid public Eval v0 dataset: ${message}`);
}

function exactKeys(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => fields.has(key));
}

function validCondition(condition) {
  return exactKeys(condition, new Set(["name", "value", "source", "scope", "hardness"]))
    && typeof condition.name === "string" && condition.source === "explicit"
    && condition.scope === "product" && condition.hardness === "hard";
}

export function validateDataset(dataset) {
  assert(exactKeys(dataset, new Set([
    "dataset_version", "schema_version", "provenance", "generated_at", "catalog_fixture",
    "description", "limitations", "gates", "cases",
  ])), "unexpected top-level field");
  assert(dataset.dataset_version === "eval-v0.1.0", "unsupported dataset_version");
  assert(dataset.schema_version === "send-from-china-eval-dataset/v0", "unsupported schema_version");
  assert(dataset.provenance === "public_synthetic", "provenance must be public_synthetic");
  assert(Number.isFinite(Date.parse(dataset.generated_at)), "generated_at must be an ISO date-time");
  assert(dataset.catalog_fixture === "fixtures/published-catalog.sample.json", "catalog fixture changed");
  assert(Array.isArray(dataset.limitations) && dataset.limitations.length >= 2, "limitations are required");
  assert(exactKeys(dataset.gates, GATE_FIELDS) && Object.values(dataset.gates).every(Number.isFinite), "invalid gates");
  assert(Array.isArray(dataset.cases) && dataset.cases.length >= 12, "at least 12 cases are required");
  const caseIds = new Set();
  for (const entry of dataset.cases) {
    assert(exactKeys(entry, new Set(["case_id", "suites", "request", "expected"])), "unexpected case field");
    assert(/^[a-z0-9][a-z0-9_-]{2,80}$/u.test(entry.case_id) && !caseIds.has(entry.case_id), "invalid or duplicate case_id");
    caseIds.add(entry.case_id);
    assert(Array.isArray(entry.suites) && entry.suites.length > 0 && entry.suites.every((suite) => SUITES.has(suite)), "invalid suite");
    assert(entry.suites.includes("full"), "every case must belong to full");
    const request = entry.request;
    assert(exactKeys(request, new Set([
      "contract_version", "product_identity", "hard_constraints", "soft_context",
      "transaction_context", "limit", "cursor",
    ])), "invalid request envelope");
    assert(request.contract_version === "2.0" && request.limit === 50 && request.cursor === null, "request must use v2 with limit 50 and a null cursor");
    assert(validCondition(request.product_identity) && request.product_identity.name === "product_identity"
      && typeof request.product_identity.value === "string" && request.product_identity.value.trim(), "invalid product identity");
    assert(Array.isArray(request.hard_constraints)
      && request.hard_constraints.every((condition) => validCondition(condition) && HARD_CONSTRAINTS.has(condition.name)), "invalid hard constraint");
    assert(Array.isArray(request.soft_context) && request.soft_context.length === 0, "Eval v0 soft context must remain empty");
    assert(Array.isArray(request.transaction_context) && request.transaction_context.length === 0, "Eval v0 transaction context must remain empty");
    assert(exactKeys(entry.expected, new Set(["status", "relevance", "forbidden_ids"])), "invalid expected result");
    assert(STATUSES.has(entry.expected.status), "invalid expected status");
    assert(Array.isArray(entry.expected.relevance) && Array.isArray(entry.expected.forbidden_ids), "invalid relevance or forbidden list");
    const relevantIds = new Set();
    for (const relevance of entry.expected.relevance) {
      assert(exactKeys(relevance, new Set(["public_id", "grade"]))
        && /^[A-Za-z0-9]{22}$/u.test(relevance.public_id)
        && Number.isInteger(relevance.grade) && relevance.grade >= 1 && relevance.grade <= 3
        && !relevantIds.has(relevance.public_id), "invalid relevance judgment");
      relevantIds.add(relevance.public_id);
    }
    assert(entry.expected.forbidden_ids.every((id) => /^[A-Za-z0-9]{22}$/u.test(id) && !relevantIds.has(id)), "invalid forbidden ID");
    assert((entry.expected.status === "results") === (relevantIds.size > 0), "results status and relevance must agree");
  }
  assert(dataset.cases.filter((entry) => entry.suites.includes("smoke")).length >= 8, "smoke needs at least 8 cases");
  assert(dataset.cases.some((entry) => entry.suites.includes("security") && entry.request.hard_constraints.length), "security needs a constrained case");
  return dataset;
}
