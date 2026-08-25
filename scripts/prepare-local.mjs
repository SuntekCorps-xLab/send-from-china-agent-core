import { copyFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerRoot = path.join(repositoryRoot, "governance-worker");
const target = path.join(workerRoot, ".dev.vars");
const example = path.join(workerRoot, ".dev.vars.example");

try {
  await access(target, constants.F_OK);
  console.log("Keeping existing governance-worker/.dev.vars.");
} catch {
  await copyFile(example, target);
  console.log("Created governance-worker/.dev.vars from the synthetic local example.");
}

console.log("Local setup only: replace the sample tenant key before sharing a deployment.");
