import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npm = process.platform === "win32" ? process.execPath : "npm";
const npmArgs = process.platform === "win32"
  ? [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
  : [];
const python = process.env.PYTHON || "python";

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...(options.env || {}) },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

const temporary = await mkdtemp(join(tmpdir(), "agent-core-"));
try {
  run(npm, [...npmArgs, "--prefix", "governance-worker", "run", "verify"]);
  run(process.execPath, ["--test", "sandbox/tests/sandbox.test.mjs"]);
  run(process.execPath, ["scripts/verify-recipes.mjs"]);
  run(process.execPath, ["--test", "starters/agent-core-js/test/starter.test.mjs"]);
  run(python, ["-m", "unittest", "discover", "-s", "recipes/python", "-p", "test_*.py", "-v"]);
  run(process.execPath, ["--test", "sdk/test/client.test.js", "sdk/test/search-contract-v2.test.js"]);
  run(process.execPath, ["scripts/generate-search-v2-types.mjs"]);
  run(process.execPath, ["--test", "scripts/generate-tenant-key.test.mjs"]);
  run(python, ["-m", "unittest", "discover", "-s", "etl-pipeline/tests", "-p", "test_*.py", "-v"]);
  run(python, ["-m", "unittest", "discover", "-s", "publisher/tests", "-p", "test_*.py", "-v"]);
  const snapshot = join(temporary, "published-catalog.json");
  const report = join(temporary, "publisher-report.json");
  run(python, [
    "publisher/build_snapshot.py",
    "--source", "publisher/samples/catalog-input.sample.json",
    "--output", snapshot,
    "--report", report,
  ], { env: { CATALOG_ID_KEY: "local_v1_verification_key_32_bytes_minimum" } });
  run(process.execPath, ["scripts/validate-snapshot.mjs", snapshot]);
  run(process.execPath, ["scripts/check-doc-links.mjs"]);
  run(process.execPath, ["scripts/scan-public.mjs", "."]);
  console.log("\nPASS: Agent Core verification");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
