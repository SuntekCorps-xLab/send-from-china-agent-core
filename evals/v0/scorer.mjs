const SUPPORTED_STATUSES = new Set(["results", "needs_clarification", "no_match", "degraded"]);

function rounded(value) {
  return value === null ? null : Number(value.toFixed(6));
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function values(value) {
  return Array.isArray(value) ? value : [value];
}

function words(value) {
  return String(value || "").toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/u).filter(Boolean);
}

function containsAll(haystack, criterion) {
  const text = words(haystack).join(" ");
  const terms = words(criterion);
  return terms.length > 0 && terms.every((term) => text.includes(term));
}

function productText(product) {
  return [
    product?.title,
    product?.description,
    product?.category,
    ...(Array.isArray(product?.tags) ? product.tags : []),
    ...Object.values(product?.attributes || {}),
  ].join(" ");
}

function attributeText(product, name) {
  const selected = Object.entries(product?.attributes || {})
    .filter(([key]) => words(key).includes(name))
    .map(([, value]) => value);
  return [...selected, product?.title, product?.description, ...(product?.tags || [])].join(" ");
}

function satisfies(product, condition) {
  const conditionValues = values(condition.value);
  if (condition.name === "price_max") {
    return Number.isFinite(Number(product?.price?.amount))
      && conditionValues.every((value) => Number(product.price.amount) <= Number(value));
  }
  if (condition.name === "price_min") {
    return Number.isFinite(Number(product?.price?.amount))
      && conditionValues.every((value) => Number(product.price.amount) >= Number(value));
  }
  if (condition.name === "material" || condition.name === "color") {
    return conditionValues.every((value) => containsAll(attributeText(product, condition.name), value));
  }
  if (condition.name === "must_have") {
    return conditionValues.every((value) => containsAll(productText(product), value));
  }
  if (condition.name === "exclude") {
    return conditionValues.every((value) => !containsAll(productText(product), value));
  }
  return false;
}

function dcg(ids, grades, limit) {
  return ids.slice(0, limit).reduce((total, id, index) => {
    const grade = grades.get(id) || 0;
    return total + ((2 ** grade) - 1) / Math.log2(index + 2);
  }, 0);
}

export function scoreCase(testCase, prediction) {
  const expectedGrades = new Map(testCase.expected.relevance
    .map(({ public_id: publicId, grade }) => [publicId, grade]));
  const forbidden = new Set(testCase.expected.forbidden_ids);
  const results = Array.isArray(prediction?.results) ? prediction.results : [];
  const resultIds = results.map((result) => String(result?.public_id || ""));
  const validIds = resultIds.filter((id) => /^[A-Za-z0-9]{22}$/u.test(id));
  const uniqueIds = [...new Set(validIds)];
  const relevantCount = expectedGrades.size;
  const relevantAt = (limit) => new Set(uniqueIds.slice(0, limit).filter((id) => expectedGrades.has(id))).size;
  const recallAt20 = relevantCount ? relevantAt(20) / relevantCount : null;
  const recallAt50 = relevantCount ? relevantAt(50) / relevantCount : null;
  // Public fixtures often return fewer than ten valid products. Use the
  // visible Top-10 set as the denominator so this remains a precision/noise
  // measure instead of penalizing a truthful short result set for empty slots.
  const visibleAt10 = uniqueIds.slice(0, 10).length;
  const precisionAt10 = relevantCount && visibleAt10 ? relevantAt(10) / visibleAt10 : null;
  const ideal = [...expectedGrades.values()].sort((left, right) => right - left);
  const idealDcg = ideal.reduce((total, grade, index) => total + ((2 ** grade) - 1) / Math.log2(index + 2), 0);
  const ndcgAt10 = relevantCount ? dcg(uniqueIds, expectedGrades, 10) / idealDcg : null;
  const forbiddenIds = uniqueIds.filter((id) => forbidden.has(id));
  const duplicates = validIds.filter((id, index) => validIds.indexOf(id) !== index);
  const hardConstraintViolations = [];
  for (const result of results) {
    for (const condition of testCase.request.hard_constraints) {
      if (!satisfies(result, condition)) {
        hardConstraintViolations.push({
          public_id: String(result?.public_id || "invalid_public_id"),
          constraint: condition.name,
        });
      }
    }
  }
  const status = SUPPORTED_STATUSES.has(prediction?.status) ? prediction.status : "invalid";
  const statusMatch = status === testCase.expected.status;
  const retrievalComplete = recallAt50 === null || recallAt50 === 1;
  return {
    case_id: testCase.case_id,
    passed: statusMatch && retrievalComplete && forbiddenIds.length === 0
      && hardConstraintViolations.length === 0 && duplicates.length === 0
      && validIds.length === resultIds.length,
    expected_status: testCase.expected.status,
    actual_status: status,
    returned_ids: uniqueIds.slice(0, 50),
    metrics: {
      recall_at_20: rounded(recallAt20),
      recall_at_50: rounded(recallAt50),
      precision_at_10: rounded(precisionAt10),
      ndcg_at_10: rounded(ndcgAt10),
      status_match: statusMatch,
    },
    violations: {
      forbidden_ids: forbiddenIds,
      hard_constraints: hardConstraintViolations,
      duplicate_ids: [...new Set(duplicates)],
      invalid_result_id_count: resultIds.length - validIds.length,
    },
  };
}

function atLeast(actual, threshold) {
  return actual !== null && actual + Number.EPSILON >= threshold;
}

export function scoreSuite(cases, predictions, gates) {
  const scoredCases = cases.map((testCase) => scoreCase(testCase, predictions.get(testCase.case_id)));
  const ranked = scoredCases.filter((entry) => entry.metrics.recall_at_50 !== null);
  const metrics = {
    case_count: scoredCases.length,
    ranked_case_count: ranked.length,
    recall_at_20: rounded(mean(ranked.map((entry) => entry.metrics.recall_at_20))),
    recall_at_50: rounded(mean(ranked.map((entry) => entry.metrics.recall_at_50))),
    precision_at_10: rounded(mean(ranked.map((entry) => entry.metrics.precision_at_10))),
    ndcg_at_10: rounded(mean(ranked.map((entry) => entry.metrics.ndcg_at_10))),
    status_accuracy: rounded(mean(scoredCases.map((entry) => entry.metrics.status_match ? 1 : 0))),
    forbidden_id_hits: scoredCases.reduce((total, entry) => total + entry.violations.forbidden_ids.length, 0),
    hard_constraint_violations: scoredCases.reduce((total, entry) => total + entry.violations.hard_constraints.length, 0),
    duplicate_id_hits: scoredCases.reduce((total, entry) => total + entry.violations.duplicate_ids.length, 0),
    invalid_result_ids: scoredCases.reduce((total, entry) => total + entry.violations.invalid_result_id_count, 0),
  };
  const checks = {
    recall_at_20: atLeast(metrics.recall_at_20, gates.minimum_recall_at_20),
    recall_at_50: atLeast(metrics.recall_at_50, gates.minimum_recall_at_50),
    precision_at_10: atLeast(metrics.precision_at_10, gates.minimum_precision_at_10),
    ndcg_at_10: atLeast(metrics.ndcg_at_10, gates.minimum_ndcg_at_10),
    status_accuracy: atLeast(metrics.status_accuracy, gates.minimum_status_accuracy),
    forbidden_id_hits: metrics.forbidden_id_hits <= gates.maximum_forbidden_id_hits,
    hard_constraint_violations: metrics.hard_constraint_violations <= gates.maximum_hard_constraint_violations,
    duplicate_id_hits: metrics.duplicate_id_hits <= gates.maximum_duplicate_id_hits,
    invalid_result_ids: metrics.invalid_result_ids === 0,
    case_outcomes: scoredCases.every((entry) => entry.passed),
  };
  return {
    passed: Object.values(checks).every(Boolean),
    metrics,
    gate_checks: checks,
    cases: scoredCases,
  };
}
