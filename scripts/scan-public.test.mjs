import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scanPublic } from "./scan-public.mjs";

async function withFixture(files, run) {
  const root = await mkdtemp(join(tmpdir(), "agent-core-public-scan-"));
  try {
    for (const [path, value] of Object.entries(files)) {
      const target = join(root, path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, value, "utf8");
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("reports every blocked finding with an exact line number", async () => {
  await withFixture({
    "docs/example.md": ["safe", "http://127.0.0.1:4173", String.fromCodePoint(0x4e2d)].join("\n"),
  }, async (root) => {
    assert.deepEqual(await scanPublic(root), [
      "docs/example.md:2: private network",
      "docs/example.md:3: Han character",
    ]);
  });
});

test("allows only the two explicit loopback development cases", async () => {
  await withFixture({
    "docs/sandbox.md": "http://127.0.0.1:8787/sandbox",
    "test/reference-store.test.mjs": "const origin = 'http://127.0.0.1:4173';",
    "test/private-network.test.mjs": `const origin = 'http://${["10", "0", "0", "8"].join(".")}:4173';`,
  }, async (root) => {
    assert.deepEqual(await scanPublic(root), ["test/private-network.test.mjs:1: private network"]);
  });
});

test("requires an explicit marker for Han-only test fixture values", async () => {
  await withFixture({
    "test/allowed.test.mjs": `${String.fromCodePoint(0x4e2d)} // public-scan: allow-han-test-fixture`,
    "test/unmarked.test.mjs": String.fromCodePoint(0x6587),
  }, async (root) => {
    assert.deepEqual(await scanPublic(root), ["test/unmarked.test.mjs:1: Han character"]);
  });
});
