import { readFile, readdir, lstat } from "node:fs/promises";
import { relative, resolve } from "node:path";

const ROOT = resolve(process.argv[2] || ".");
const EXCLUDED = new Set([".git", "node_modules", "build", "coverage", ".wrangler"]);
const MAX_FILE_BYTES = 1024 * 1024;
const PATTERNS = [
  ["private key", /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/i],
  ["credential token", /\b(?:glpat-|glft-|ghp_|github_pat_|shpat_|shpss_|shptka_|xox[baprs]-)[A-Za-z0-9._-]{10,}/i],
  ["model API key", /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/im],
  ["authorization value", /authorization\s*[:=]\s*["']?(?:bearer|basic)\s+[A-Za-z0-9+/=._-]{8,}/i],
  ["cloud access key", /\bAKIA[A-Z0-9]{16}\b/],
  ["private network", /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|127\.0\.0\.1(?!:8787\b)|169\.254\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/],
  ["private host", /(?:gitlab\.|rds\.|internal\.|corp\.)[a-z0-9.-]+/i],
  ["developer path", /(?:[A-Za-z]:[\\/]Users[\\/]|\/Users\/|\/home\/)[^\s"']+/i],
  ["private integration", /\b(?:PIPO|StoryLab|DCD|SFC|ERiC|iStore|iShip2)\b/i],
  ["Han character", /[\u3400-\u9fff]/u],
  ["outbound fetch in worker", /(?:await|globalThis\.)\s*fetch\s*\(/,
    (path) => path.startsWith("governance-worker/src/")],
  ["internal codename", /\b(?:Aquilla|M4X|istore2|advtmanager)\b/i],
];

async function filesUnder(path) {
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue;
    const child = resolve(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${relative(ROOT, child)}`);
    if (entry.isDirectory()) output.push(...await filesUnder(child));
    else if (entry.isFile()) output.push(child);
  }
  return output;
}

const findings = [];
for (const file of await filesUnder(ROOT)) {
  const relativePath = relative(ROOT, file).replaceAll("\\", "/");
  if (relativePath === "scripts/scan-public.mjs") continue;
  const stats = await lstat(file);
  const data = await readFile(file);
  if (data.subarray(0, 8192).includes(0)) continue;
  if (stats.size > MAX_FILE_BYTES) {
    findings.push(`${relative(ROOT, file)}: text file exceeds ${MAX_FILE_BYTES} bytes`);
    continue;
  }
  const text = data.toString("utf8");
  for (const [label, pattern, pathPredicate] of PATTERNS) {
    if (pathPredicate && !pathPredicate(relativePath)) continue;
    if (pattern.test(text)) findings.push(`${relative(ROOT, file)}: ${label}`);
  }
}

if (findings.length) {
  for (const finding of findings) console.error(`BLOCKED: ${finding}`);
  process.exit(1);
}
console.log("PASS: public repository safety scan");
