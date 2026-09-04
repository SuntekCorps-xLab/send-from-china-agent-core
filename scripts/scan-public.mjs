import { readFile, readdir, lstat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXCLUDED = new Set([".git", "node_modules", "build", "coverage", ".wrangler"]);
const MAX_FILE_BYTES = 1024 * 1024;
const PATTERNS = [
  ["private key", /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/i],
  ["credential token", /\b(?:glpat-|glft-|ghp_|github_pat_|shpat_|shpss_|shptka_|xox[baprs]-)[A-Za-z0-9._-]{10,}/i],
  ["model API key", /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/im],
  ["authorization value", /authorization\s*[:=]\s*["']?(?:bearer|basic)\s+[A-Za-z0-9+/=._-]{8,}/i],
  ["cloud access key", /\bAKIA[A-Z0-9]{16}\b/],
  ["private network", /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|127\.0\.0\.1(?::\d{1,5})?|169\.254\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/],
  ["private host", /(?:gitlab\.|rds\.|internal\.|corp\.)[a-z0-9.-]+/i],
  ["developer path", /(?:[A-Za-z]:[\\/]Users[\\/]|\/Users\/|\/home\/)[^\s"']+/i],
  ["private integration", /\b(?:PIPO|StoryLab|DCD|SFC|ERiC|iStore|iShip2)\b/i],
  ["Han character", /[\u3400-\u9fff]/u],
  ["outbound fetch in worker", /(?:await|globalThis\.)\s*fetch\s*\(/,
    (path) => path.startsWith("governance-worker/src/")],
  ["outbound network in publisher", /(?:urllib\.request|requests\s*\.|httpx\s*\.|socket\s*\.|urlopen\s*\()/,
    (path) => path.startsWith("publisher/") && path.endsWith(".py")],
  ["internal codename", /\b(?:Aquilla|M4X|istore2|advtmanager)\b/i],
];

function isTestOnlyPath(path) {
  return /(?:^|\/)(?:test|tests)(?:\/|$)/u.test(path)
    || /(?:^|\/)[^/]+\.test\.[cm]?[jt]s$/u.test(path)
    || /(?:^|\/)test_[^/]+\.py$/u.test(path);
}

function allowedFinding(label, match, relativePath, line) {
  if (label === "private network") {
    if (match === "127.0.0.1:8787" || match === "127.0.0.1:8790") return true;
    if (match === "127.0.0.1" && relativePath === "governance-worker/wrangler.toml"
      && line === 'ip = "127.0.0.1"') return true;
    if (match === "127.0.0.1:4173" && isTestOnlyPath(relativePath)) return true;
  }
  if (label === "Han character") {
    return isTestOnlyPath(relativePath) && line.includes("public-scan: allow-han-test-fixture");
  }
  return false;
}

function patternMatches(pattern, line) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...line.matchAll(new RegExp(pattern.source, flags))];
}

async function filesUnder(path, root) {
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue;
    const child = resolve(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${relative(root, child)}`);
    if (entry.isDirectory()) output.push(...await filesUnder(child, root));
    else if (entry.isFile()) output.push(child);
  }
  return output;
}

export async function scanPublic(rootPath = ".") {
  const root = resolve(rootPath);
  const findings = [];
  for (const file of await filesUnder(root, root)) {
    const relativePath = relative(root, file).replaceAll("\\", "/");
    if (relativePath === "scripts/scan-public.mjs") continue;
    const stats = await lstat(file);
    const data = await readFile(file);
    if (data.subarray(0, 8192).includes(0)) continue;
    if (stats.size > MAX_FILE_BYTES) {
      findings.push(`${relativePath}: text file exceeds ${MAX_FILE_BYTES} bytes`);
      continue;
    }
    const lines = data.toString("utf8").split(/\r?\n/u);
    for (const [label, pattern, pathPredicate] of PATTERNS) {
      if (pathPredicate && !pathPredicate(relativePath)) continue;
      for (const [index, line] of lines.entries()) {
        const blocked = patternMatches(pattern, line)
          .some((match) => !allowedFinding(label, match[0], relativePath, line));
        if (blocked) {
          findings.push(`${relativePath}:${index + 1}: ${label}`);
        }
      }
    }
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = await scanPublic(process.argv[2] || ".");
  if (findings.length) {
    for (const finding of findings) console.error(`BLOCKED: ${finding}`);
    process.exit(1);
  }
  console.log("PASS: public repository safety scan");
}
