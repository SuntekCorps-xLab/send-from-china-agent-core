import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import worker from "../governance-worker/src/index.js";
import { ALPHA_KEY, ENV } from "../governance-worker/test/test-env.js";
import { DEFAULT_SANDBOX_PORT, startSandbox } from "../sandbox/server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const workerUrl = "http://127.0.0.1:8787";
const sandboxUrl = "http://127.0.0.1:8790";

async function smoke(baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/smoke-public.mjs", ...(baseUrl ? ["--url", baseUrl] : [])], {
      cwd: root,
      env: { ...process.env, TENANT_KEY: ALPHA_KEY, AGENT_CORE_URL: "" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("both sandbox health paths identify the synthetic process", async () => {
  const sandbox = await startSandbox({ port: 0 });
  try {
    for (const pathname of ["/health", "/sandbox/health"]) {
      const response = await fetch(`${sandbox.baseUrl}${pathname}`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.mode, "synthetic_local_sandbox");
      assert.equal(body.data_source, "synthetic_fixture");
      assert.equal(body.purchasable, false);
      assert.equal(body.writes_enabled, false);
      assert.equal(response.headers.get("x-send-from-china-sandbox-mode"), "synthetic_local_sandbox");
    }
  } finally {
    await sandbox.close();
  }
});

test("Worker smoke rejects a sandbox health response before authenticated requests", async () => {
  const sandbox = await startSandbox({ port: 0 });
  let credentialedRequests = 0;
  sandbox.server.on("request", (request) => {
    if (request.headers.authorization) credentialedRequests += 1;
  });
  try {
    const result = await smoke(sandbox.baseUrl);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Worker profile required; the selected URL serves a synthetic sandbox/u);
    assert.equal(credentialedRequests, 0);
  } finally {
    await sandbox.close();
  }
});

test("real-launcher configuration guard fails before network calls without echoing configuration", async () => {
  const temporaryRoot = await realpath(tmpdir());
  const fixture = await mkdtemp(join(temporaryRoot, "agent-core-config-guard-"));
  const exampleSentinel = "synthetic_example_config_sentinel";
  const localSentinel = "synthetic_local_config_sentinel";
  try {
    await mkdir(join(fixture, "governance-worker"));
    await writeFile(join(fixture, "governance-worker/.dev.vars.example"), `FIXTURE_VALUE=${exampleSentinel}\n`);
    await writeFile(join(fixture, "governance-worker/.dev.vars"), `FIXTURE_VALUE=${localSentinel}\n`);
    const preload = join(fixture, "deny-network.mjs");
    await writeFile(preload, `
      import { writeFileSync } from "node:fs";
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts += 1;
        throw new Error("Unexpected network attempt before configuration validation");
      };
      process.on("exit", () => writeFileSync("network-attempts.json", JSON.stringify({ attempts })));
    `);
    const result = spawnSync(process.execPath, [
      "--import", pathToFileURL(preload).href,
      fileURLToPath(new URL("./check-running-local-profiles.mjs", import.meta.url)),
    ], {
      cwd: fixture,
      env: { ...process.env, NODE_OPTIONS: "" },
      encoding: "utf8",
      timeout: 10000,
      shell: false,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Real-launcher verification requires the unchanged synthetic local fixture configuration/u);
    for (const output of [result.stdout, result.stderr]) {
      assert.ok(!output.includes(exampleSentinel));
      assert.ok(!output.includes(localSentinel));
    }
    assert.deepEqual(JSON.parse(await readFile(join(fixture, "network-attempts.json"), "utf8")), { attempts: 0 });
  } finally {
    assert.equal(dirname(fixture), temporaryRoot);
    await rm(fixture, { recursive: true, force: true });
  }
});

test("sandbox and Worker handler serve independent profiles concurrently", async () => {
  // Exercise the real Worker handler through a loopback HTTP adapter, without Wrangler or network services.
  // Ephemeral ports leave a developer's already-running default services untouched.
  let origin;
  const workerServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const method = request.method;
    const result = await worker.fetch(new Request(new URL(request.url, origin), {
      method,
      headers: request.headers,
      ...(chunks.length && method !== "GET" && method !== "HEAD" ? { body: Buffer.concat(chunks) } : {}),
    }), ENV);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  let sandbox;
  try {
    await new Promise((resolve, reject) => {
      workerServer.once("error", reject);
      workerServer.listen(0, new URL(workerUrl).hostname, resolve);
    });
    origin = `http://${new URL(workerUrl).hostname}:${workerServer.address().port}`;
    sandbox = await startSandbox({ port: 0 });
    assert.notEqual(sandbox.baseUrl, origin);
    const workerHealth = await (await fetch(`${origin}/health`)).json();
    assert.equal(workerHealth.mode, "published_snapshot_gateway");
    const sandboxHealth = await (await fetch(`${sandbox.baseUrl}/health`)).json();
    assert.equal(sandboxHealth.mode, "synthetic_local_sandbox");
    const workerSearch = await fetch(`${origin}/api/search?q=desk&limit=5`, {
      headers: { authorization: `Bearer ${ALPHA_KEY}` },
    });
    assert.equal(workerSearch.status, 200);
    assert.equal((await workerSearch.json()).items[0].slug, "modular-desk-organizer");
    const sandboxSearch = await (await fetch(`${sandbox.baseUrl}/sandbox/api/search?q=desk&limit=5`)).json();
    assert.equal(sandboxSearch.items[0].slug, "modular-desk-organizer");
    assert.equal(sandboxSearch.items[0].purchasable, false);
    const result = await smoke(origin);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).base_url, origin);
  } finally {
    await sandbox?.close();
    await new Promise((resolve) => workerServer.close(resolve));
  }
});

test("launcher configuration and every copyable sandbox profile use distinct defaults", async () => {
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const config = await read("governance-worker/wrangler.toml");
  assert.match(config, /\[dev\][\s\S]*?ip\s*=\s*"127\.0\.0\.1"/u);
  assert.match(config, /\[dev\][\s\S]*?port\s*=\s*8787\b/u);
  assert.equal(DEFAULT_SANDBOX_PORT, Number(new URL(sandboxUrl).port));
  assert.notEqual(DEFAULT_SANDBOX_PORT, Number(new URL(workerUrl).port));
  const readme = await read("README.md");
  assert.ok(readme.includes(`curl ${workerUrl}/health`));
  assert.ok(readme.includes(`curl "${workerUrl}/api/search?q=desk&limit=5"`));
  for (const path of [
    "README.md", "docs/SANDBOX.md", "recipes/mcp/README.md", "recipes/curl/README.md",
    "recipes/javascript/search-v2.mjs", "recipes/python/search.py", "starters/agent-core-js/src/index.mjs",
  ]) {
    const contents = await read(path);
    assert.ok(contents.includes(sandboxUrl), `${path} must use the sandbox default`);
    assert.ok(!contents.includes(`${workerUrl}/sandbox`), `${path} must not send sandbox calls to the Worker`);
  }
});
