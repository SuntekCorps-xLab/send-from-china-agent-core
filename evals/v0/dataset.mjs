const SUITES = new Set(["smoke", "full", "security", "perf"]);
const STATUSES = new Set(["results", "needs_clarification", "no_match", "degraded"]);
const HARD_CONSTRAINTS = new Set(["price_min", "price_max", "material", "color", "must_have", "exclude"]);
const GATE_FIELDS = new Set([
  "minimum_recall_at_20", "minimum_recall_at_50", "minimum_precision_at_10",
  "minimum_ndcg_at_10", "minimum_status_accuracy", "maximum_forbidden_id_hits",
  "maximum_hard_constraint_violations", "maximum_duplicate_id_hits",
]);
const PROVENANCE = new Set(["public_synthetic", "private_live"]);

export const PRIVATE_LIVE_GATES = Object.freeze({
  minimum_recall_at_20: 0.9,
  minimum_recall_at_50: 0.95,
  minimum_precision_at_10: 0.85,
  minimum_ndcg_at_10: 0.8,
  minimum_status_accuracy: 1,
  maximum_forbidden_id_hits: 0,
  maximum_hard_constraint_violations: 0,
  maximum_duplicate_id_hits: 0,
});

function assert(condition, message) {
  if (!condition) throw new TypeError(`Invalid Eval v0 dataset: ${message}`);
}

function exactKeys(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((key) => fields.has(key));
}

function validIsoDateTime(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth[month - 1]
    && hour >= 0 && hour <= 23
    && minute >= 0 && minute <= 59
    && second >= 0 && second <= 59
    && offsetHour >= 0 && offsetHour <= 23
    && offsetMinute >= 0 && offsetMinute <= 59;
}

function validCondition(condition) {
  return exactKeys(condition, new Set(["name", "value", "source", "scope", "hardness"]))
    && typeof condition.name === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(condition.name)
    && condition.source === "explicit"
    && condition.scope === "product" && condition.hardness === "hard";
}

function validTextCriterion(value) {
  const validText = (item) => typeof item === "string"
    && item.trim().length > 0 && item.length <= 80;
  return validText(value) || (Array.isArray(value) && value.length >= 1
    && value.length <= 20 && value.every(validText));
}

function validHardConstraint(condition) {
  if (!validCondition(condition) || !HARD_CONSTRAINTS.has(condition.name)) return false;
  if (condition.name === "price_min" || condition.name === "price_max") {
    return typeof condition.value === "number" && Number.isFinite(condition.value) && condition.value >= 0;
  }
  return validTextCriterion(condition.value);
}

export function validateDataset(dataset) {
  assert(exactKeys(dataset, new Set([
    "dataset_version", "schema_version", "provenance", "generated_at", "catalog_fixture",
    "description", "limitations", "gates", "cases",
  ])), "unexpected top-level field");
  assert(/^[a-z0-9][a-z0-9._-]{2,80}$/u.test(dataset.dataset_version), "unsupported dataset_version");
  assert(dataset.schema_version === "send-from-china-eval-dataset/v0", "unsupported schema_version");
  assert(PROVENANCE.has(dataset.provenance), "unsupported provenance");
  assert(validIsoDateTime(dataset.generated_at), "generated_at must be an ISO date-time");
  assert(typeof dataset.description === "string" && dataset.description.trim().length > 0
    && dataset.description.length <= 500, "description is invalid");
  if (dataset.provenance === "public_synthetic") {
    assert(dataset.dataset_version === "eval-v0.1.0", "public dataset version changed");
    assert(dataset.catalog_fixture === "fixtures/published-catalog.sample.json", "public catalog fixture changed");
  } else {
    assert(/^private-[a-z0-9][a-z0-9._-]{2,72}$/u.test(dataset.dataset_version), "private dataset version must use a private- prefix");
    assert(/^private-snapshot:[0-9a-f]{64}$/u.test(dataset.catalog_fixture), "private catalog snapshot must be opaque");
  }
  assert(Array.isArray(dataset.limitations) && dataset.limitations.length >= 2 && dataset.limitations.length <= 20
    && dataset.limitations.every((value) => typeof value === "string" && value.trim().length > 0 && value.length <= 300), "limitations are invalid");
  assert(exactKeys(dataset.gates, GATE_FIELDS) && Object.values(dataset.gates).every(Number.isFinite), "invalid gates");
  for (const field of [
    "minimum_recall_at_20", "minimum_recall_at_50", "minimum_precision_at_10",
    "minimum_ndcg_at_10", "minimum_status_accuracy",
  ]) {
    assert(dataset.gates[field] >= 0 && dataset.gates[field] <= 1, `gate ${field} is outside 0..1`);
  }
  for (const field of [
    "maximum_forbidden_id_hits", "maximum_hard_constraint_violations", "maximum_duplicate_id_hits",
  ]) {
    assert(Number.isInteger(dataset.gates[field]) && dataset.gates[field] >= 0, `gate ${field} must be a non-negative integer`);
  }
  if (dataset.provenance === "private_live") {
    for (const [field, expected] of Object.entries(PRIVATE_LIVE_GATES)) {
      assert(dataset.gates[field] === expected, `private gate ${field} cannot change`);
    }
  }
  assert(Array.isArray(dataset.cases) && dataset.cases.length >= 12, "at least 12 cases are required");
  const caseIds = new Set();
  for (const entry of dataset.cases) {
    assert(exactKeys(entry, new Set(["case_id", "suites", "request", "expected"])), "unexpected case field");
    assert(/^[a-z0-9][a-z0-9_-]{2,80}$/u.test(entry.case_id) && !caseIds.has(entry.case_id), "invalid or duplicate case_id");
    caseIds.add(entry.case_id);
    assert(Array.isArray(entry.suites) && entry.suites.length > 0
      && entry.suites.length === new Set(entry.suites).size
      && entry.suites.every((suite) => SUITES.has(suite)), "invalid suite");
    assert(entry.suites.includes("full"), "every case must belong to full");
    const request = entry.request;
    assert(exactKeys(request, new Set([
      "contract_version", "product_identity", "hard_constraints", "soft_context",
      "transaction_context", "limit", "cursor",
    ])), "invalid request envelope");
    assert(request.contract_version === "2.0" && request.limit === 50 && request.cursor === null, "request must use v2 with limit 50 and a null cursor");
    assert(validCondition(request.product_identity) && request.product_identity.name === "product_identity"
      && typeof request.product_identity.value === "string" && request.product_identity.value.trim()
      && request.product_identity.value.length <= 300, "invalid product identity");
    assert(Array.isArray(request.hard_constraints) && request.hard_constraints.length <= 50
      && request.hard_constraints.every(validHardConstraint), "invalid hard constraint");
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
    assert(entry.expected.forbidden_ids.length === new Set(entry.expected.forbidden_ids).size
      && entry.expected.forbidden_ids.every((id) => /^[A-Za-z0-9]{22}$/u.test(id) && !relevantIds.has(id)), "invalid forbidden ID");
    assert((entry.expected.status === "results") === (relevantIds.size > 0), "results status and relevance must agree");
  }
  assert(dataset.cases.filter((entry) => entry.suites.includes("smoke")).length >= 8, "smoke needs at least 8 cases");
  assert(dataset.cases.some((entry) => entry.suites.includes("security") && entry.request.hard_constraints.length), "security needs a constrained case");
  return dataset;
}
