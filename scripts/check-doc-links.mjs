import { access, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const root = resolve(process.argv[2] || ".");
const excluded = new Set([".git", "node_modules", "build", "coverage", ".wrangler"]);

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const child = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(child));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(child);
  }
  return files;
}

const failures = [];
for (const file of await markdownFiles(root)) {
  const markdown = await readFile(file, "utf8");
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    target = target.split(/\s+["']/u, 1)[0];
    if (!target || target.startsWith("#") || /^(?:https?:|mailto:)/i.test(target)) continue;
    const path = decodeURIComponent(target.split(/[?#]/u, 1)[0]);
    try {
      await access(resolve(dirname(file), path));
    } catch {
      failures.push(`${relative(root, file)} -> ${target}`);
    }
  }
}

if (failures.length) {
  failures.forEach((failure) => console.error(`BROKEN: ${failure}`));
  process.exit(1);
}
console.log("PASS: local documentation links");
