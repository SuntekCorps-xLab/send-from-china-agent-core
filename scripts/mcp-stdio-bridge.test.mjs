import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";

test("stdio bridge completes the MCP lifecycle without emitting notification responses", async () => {
  const secretCanary = "SECRET_CANARY_MUST_NOT_APPEAR";
  const child = spawn(process.execPath, ["scripts/mcp-stdio-bridge.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, SECRET_CANARY: secretCanary },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = [];
  const errors = [];
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => output.push(JSON.parse(line)));
  createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => errors.push(line));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "search",
    method: "tools/call",
    params: { name: "product_search", arguments: { query: "desk" } },
  })}\n`);
  child.stdin.end();

  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.equal(output.length, 3);
  assert.equal(output[0].id, "init");
  assert.equal(output[0].result.protocolVersion, "2025-06-18");
  assert.equal(output[1].id, "tools");
  assert.ok(output[1].result.tools.some((tool) => tool.name === "product_search"));
  assert.equal(output[2].id, "search");
  assert.equal(output[2].result.isError, false);
  assert.ok(output[2].result.structuredContent.products.length > 0);
  assert.doesNotMatch(JSON.stringify({ output, errors }), new RegExp(secretCanary, "u"));
});

test("stdio bridge rejects bad frames and recovers for the next valid request", async () => {
  const child = spawn(process.execPath, ["scripts/mcp-stdio-bridge.mjs"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = [];
  const errors = [];
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => output.push(JSON.parse(line)));
  createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => errors.push(line));

  child.stdin.write("{not-json}\n");
  child.stdin.write(`${"x".repeat(32 * 1024 + 1)}\n`);
  child.stdin.write("null\n");
  child.stdin.write('"primitive"\n');
  child.stdin.write("[]\n");
  child.stdin.write(`${JSON.stringify({ unexpected: true })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" })}\n`);
  child.stdin.end();

  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.equal(output.length, 7);
  assert.equal(output[0].error.code, -32700);
  assert.equal(output[1].error.message, "Frame too large");
  assert.deepEqual(output.slice(2, 6).map((message) => message.error.code), [-32600, -32600, -32600, -32600]);
  assert.equal(output[6].id, "tools");
  assert.ok(output[6].result.tools.some((tool) => tool.name === "product_search"));
});
