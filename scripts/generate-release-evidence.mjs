import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SHA1 = /^[0-9a-f]{40}$/u;
const HTTPS = /^https:\/\/[^\s]+$/u;

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function component(value, repository, version) {
  return exactKeys(value, ["repository", "version", "commit", "tree"])
    && value.repository === repository
    && value.version === version
    && SHA1.test(value.commit)
    && SHA1.test(value.tree);
}

export function validatePairedEvidence(value, identity) {
  const valid = exactKeys(value, ["schema_version", "generated_at", "agent_core", "reference_store", "execution", "gates"])
    && value.schema_version === "agent-core-reference-store-paired-e2e/v1"
    && typeof value.generated_at === "string"
    && Number.isFinite(Date.parse(value.generated_at))
    && component(value.agent_core, "send-from-china-agent-core", "1.2.0")
    && component(value.reference_store, "send-from-china-reference-store", "1.1.0")
    && value.agent_core.commit === identity.commit
    && value.agent_core.tree === identity.tree
    && exactKeys(value.execution, ["mode", "journeys", "passed", "failed"])
    && ["synthetic", "shopify_app_proxy"].includes(value.execution.mode)
    && Number.isInteger(value.execution.journeys)
    && value.execution.journeys >= 10
    && value.execution.passed === value.execution.journeys
    && value.execution.failed === 0
    && exactKeys(value.gates, ["status", "same_origin_bff", "browser_credentials", "commerce_writes", "credential_exposure", "app_proxy_live_verified"])
    && value.gates.status === "PASS"
    && value.gates.same_origin_bff === true
    && value.gates.browser_credentials === 0
    && value.gates.commerce_writes === 0
    && value.gates.credential_exposure === 0
    && typeof value.gates.app_proxy_live_verified === "boolean"
    && (value.execution.mode !== "shopify_app_proxy" || value.gates.app_proxy_live_verified === true);
  if (!valid) throw new Error("PAIRED_RELEASE_EVIDENCE_INVALID");
  return value;
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

export function currentReleaseIdentity() {
  if (git("status", "--porcelain=v1")) throw new Error("RELEASE_WORKTREE_NOT_CLEAN");
  const tags = git("tag", "--points-at", "HEAD").split(/\r?\n/u).filter(Boolean);
  if (!tags.includes("v1.2.0")) throw new Error("RELEASE_TAG_NOT_AT_HEAD");
  return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("INVALID_ARGUMENTS");
    values[key.slice(2)] = value;
  }
  const required = ["paired-artifact", "ci-url", "codeql-url", "sbom-url", "browser-url", "security-url", "output"];
  if (!required.every((key) => values[key])) throw new Error(`REQUIRED_ARGUMENTS: ${required.join(", ")}`);
  if (![values["ci-url"], values["codeql-url"], values["sbom-url"], values["browser-url"], values["security-url"]].every((url) => HTTPS.test(url))) {
    throw new Error("EVIDENCE_URL_MUST_BE_HTTPS");
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const identity = currentReleaseIdentity();
  const pairedBytes = await readFile(resolve(args["paired-artifact"]));
  const paired = validatePairedEvidence(JSON.parse(pairedBytes.toString("utf8")), identity);
  const release = {
    schema_version: "send-from-china-agent-core-release-evidence/v1",
    generated_at: new Date().toISOString(),
    release: { repository: "send-from-china-agent-core", version: "1.2.0", tag: "v1.2.0", ...identity },
    reference_store: paired.reference_store,
    paired_e2e: {
      artifact_name: basename(resolve(args["paired-artifact"])),
      sha256: createHash("sha256").update(pairedBytes).digest("hex"),
      mode: paired.execution.mode,
      journeys: paired.execution.journeys,
      app_proxy_live_verified: paired.gates.app_proxy_live_verified
    },
    evidence: {
      ci: args["ci-url"], codeql: args["codeql-url"], sbom: args["sbom-url"],
      browser: args["browser-url"], security: args["security-url"]
    }
  };
  await writeFile(resolve(args.output), `${JSON.stringify(release, null, 2)}\n`, { flag: "wx" });
  console.log(`PASS: wrote release evidence for ${identity.commit}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
