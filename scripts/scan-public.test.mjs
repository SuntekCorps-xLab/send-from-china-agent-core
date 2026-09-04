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

test("allows only the explicit Worker, sandbox, and test-only reference-store ports", async () => {
  await withFixture({
    "docs/worker.md": "http://127.0.0.1:8787/health",
    "docs/sandbox.md": "http://127.0.0.1:8790/sandbox",
    "docs/other-port.md": `http://${["127", "0", "0", "1"].join(".")}:8791/sandbox`,
    "docs/no-port.md": `http://${["127", "0", "0", "1"].join(".")}/sandbox`,
    "docs/private-network.md": `http://${["10", "0", "0", "8"].join(".")}:8790/sandbox`,
    "test/reference-store.test.mjs": "const origin = 'http://127.0.0.1:4173';",
    "test/private-network.test.mjs": `const origin = 'http://${["10", "0", "0", "8"].join(".")}:4173';`,
  }, async (root) => {
    assert.deepEqual(await scanPublic(root), [
      "docs/no-port.md:1: private network",
      "docs/other-port.md:1: private network",
      "docs/private-network.md:1: private network",
      "test/private-network.test.mjs:1: private network",
    ]);
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

test("allows the exact Worker dev loopback assignment only in its Wrangler configuration", async () => {
  const loopback = ["127", "0", "0", "1"].join(".");
  await withFixture({
    "governance-worker/wrangler.toml": `[dev]\nip = "${loopback}"\n`,
    "docs/config.md": `ip = "${loopback}"`,
    "other/wrangler.toml": `ip = "${loopback}"`,
    "arbitrary.txt": `ip = "${loopback}"`,
  }, async (root) => {
    assert.deepEqual(await scanPublic(root), [
      "arbitrary.txt:1: private network",
      "docs/config.md:1: private network",
      "other/wrangler.toml:1: private network",
    ]);
  });
  await withFixture({
    "governance-worker/wrangler.toml": `host = "${loopback}"\nip = "${loopback}" # another assignment`,
  }, async (root) => {
    assert.deepEqual(await scanPublic(root), [
      "governance-worker/wrangler.toml:1: private network",
      "governance-worker/wrangler.toml:2: private network",
    ]);
  });
});
