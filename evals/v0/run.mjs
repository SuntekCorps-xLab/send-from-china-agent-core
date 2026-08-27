import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../../governance-worker/src/index.js";
import { resetTenantState } from "../../governance-worker/src/tenant.js";
import { validateDataset } from "./dataset.mjs";
import { scoreSuite } from "./scorer.mjs";

const evalDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(evalDirectory, "..", "..");
const datasetPath = resolve(evalDirectory, "dataset.json");
const EVAL_SCOPE = "public_eval_synthetic_scope";
const EVAL_ENV = Object.freeze({
  ALLOWED_ORIGINS: "",
  TENANT_KEYS: JSON.stringify({
    [EVAL_SCOPE]: {
      tenant_id: "public_eval_v0",
      product_ids: null,
      price_tier: "synthetic",
      allow_full_enumeration: true,
      max_page_size: 50,
      daily_quota: 100000,
    },
  }),
});

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function gitOutput(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error("Git metadata is required for Eval v0 evidence.");
  return result.stdout.trim();
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  if (!ordered.length) return null;
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

function milliseconds(nanoseconds) {
  return Number((Number(nanoseconds) / 1_000_000).toFixed(3));
}

export function requirePublicSyntheticDataset(dataset) {
  if (dataset.provenance !== "public_synthetic") {
    throw new TypeError("The public Eval runner accepts only public_synthetic data.");
  }
  return dataset;
}

async function executeCase(testCase) {
  let request = structuredClone(testCase.request);
  const results = [];
  let status = null;
  for (let page = 0; page < 10; page += 1) {
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("Authorization", ["Bearer", EVAL_SCOPE].join(" "));
    const response = await worker.fetch(new Request("https://eval.example.test/api/search/v2", {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    }), EVAL_ENV);
    if (!response.ok) throw new Error(`Eval case ${testCase.case_id} returned HTTP ${response.status}.`);
    const body = await response.json();
    if (status === null) status = body.status;
    else if (body.status !== "results") throw new Error(`Eval case ${testCase.case_id} changed state while paging.`);
    results.push(...(Array.isArray(body.results) ? body.results : []));
    if (!body.pagination?.next_cursor || results.length >= 50) break;
    request = { ...request, cursor: body.pagination.next_cursor };
    if (page === 9) throw new Error(`Eval case ${testCase.case_id} exceeded the page bound.`);
  }
  return { status, results: results.slice(0, 50) };
}

export async function runEvaluation({ suite, output, iterations = suite === "perf" ? 25 : 1 }) {
  if (!new Set(["smoke", "full", "security", "perf"]).has(suite)) throw new TypeError("Unknown Eval v0 suite.");
  const datasetBytes = await readFile(datasetPath);
  const dataset = requirePublicSyntheticDataset(validateDataset(JSON.parse(datasetBytes.toString("utf8"))));
  const cases = dataset.cases.filter((entry) => entry.suites.includes(suite));
  if (!cases.length) throw new Error(`Eval v0 suite ${suite} has no cases.`);
  const durations = [];
  let predictions = null;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    resetTenantState();
    const current = new Map();
    for (const testCase of cases) {
      const started = process.hrtime.bigint();
      current.set(testCase.case_id, await executeCase(testCase));
      durations.push(milliseconds(process.hrtime.bigint() - started));
    }
    if (predictions === null) predictions = current;
  }
  const scored = scoreSuite(cases, predictions, dataset.gates);
  const commit = gitOutput(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("Eval v0 requires an exact Git commit SHA.");
  const artifact = {
    schema_version: "send-from-china-eval-artifact/v0",
    runner_version: "eval-v0.1.0",
    generated_at: new Date().toISOString(),
    suite,
    provenance: "public_synthetic",
    synthetic: true,
    production_relevance_claim: false,
    production_slo_claim: false,
    repository: {
      commit,
      working_tree_dirty: gitOutput(["status", "--porcelain", "--untracked-files=normal"]).length > 0,
    },
    dataset: {
      version: dataset.dataset_version,
      sha256: createHash("sha256").update(datasetBytes).digest("hex"),
      selected_case_count: cases.length,
      total_case_count: dataset.cases.length,
    },
    execution: {
      transport: "in_process_worker",
      data_source: dataset.catalog_fixture,
      external_network_requests: 0,
      iterations,
    },
    metrics: scored.metrics,
    gates: {
      passed: scored.passed,
      thresholds: dataset.gates,
      checks: scored.gate_checks,
    },
    cases: scored.cases,
    ...(suite === "perf" ? {
      performance: {
        classification: "synthetic_local_microbenchmark",
        gate: "correctness_only_v0",
        sample_count: durations.length,
        request_latency_ms: {
          p50: percentile(durations, 0.5),
          p95: percentile(durations, 0.95),
          maximum: durations.length ? Math.max(...durations) : null,
        },
      },
    } : {}),
    limitations: dataset.limitations,
  };
  const destination = resolve(root, output || `build/eval-v0/${suite}.json`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return { artifact, destination };
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  try {
    const suite = option("--suite", "smoke");
    const iterations = Number(option("--iterations", suite === "perf" ? "25" : "1"));
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) throw new TypeError("Iterations must be an integer from 1 to 100.");
    const { artifact, destination } = await runEvaluation({ suite, output: option("--output"), iterations });
    const label = artifact.gates.passed ? "PASS" : "BLOCKED";
    console.log(`${label}: public synthetic Eval v0 ${suite}; ${artifact.dataset.selected_case_count} cases; artifact ${destination}`);
    if (!artifact.gates.passed) process.exitCode = 1;
  } catch (error) {
    console.error(`BLOCKED: public synthetic Eval v0 could not complete (${error instanceof Error ? error.message : "unknown error"}).`);
    process.exitCode = 1;
  }
}
