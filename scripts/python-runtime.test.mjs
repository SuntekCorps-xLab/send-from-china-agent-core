import assert from "node:assert/strict";
import test from "node:test";

import { resolvePythonRuntime } from "./python-runtime.mjs";

function result(version) {
  return { status: 0, stdout: `${version}\n`, stderr: "" };
}

test("uses an explicit PYTHON executable when it satisfies the minimum", () => {
  const calls = [];
  const runtime = resolvePythonRuntime({
    env: { PYTHON: "/opt/python3.12" },
    platform: "darwin",
    probe(executable) {
      calls.push(executable);
      return result("3.12.2");
    },
  });
  assert.equal(runtime.executable, "/opt/python3.12");
  assert.equal(runtime.version.minor, 12);
  assert.deepEqual(calls, ["/opt/python3.12"]);
});
test("uses python3 by default on macOS and Linux", () => {
  const runtime = resolvePythonRuntime({
    env: {},
    platform: "darwin",
    probe(executable) {
      assert.equal(executable, "python3");
      return result("3.11.9");
    },
  });
  assert.equal(runtime.executable, "python3");
});

test("falls back after a missing executable without surfacing raw ENOENT", () => {
  const calls = [];
  const runtime = resolvePythonRuntime({
    env: {},
    platform: "linux",
    probe(executable) {
      calls.push(executable);
      return executable === "python3"
        ? { status: null, error: { code: "ENOENT" } }
        : result("3.11.1");
    },
  });
  assert.equal(runtime.executable, "python");
  assert.deepEqual(calls, ["python3", "python"]);
});

test("rejects an unsupported Python with an actionable message", () => {
  assert.throws(() => resolvePythonRuntime({
    env: {},
    platform: "darwin",
    probe(executable) {
      return executable === "python3"
        ? result("3.9.6")
        : { status: null, error: { code: "ENOENT" } };
    },
  }), /Python 3\.11\+ is required\. Set PYTHON=\/path\/to\/python3\.11/u);
});

test("rejects a missing configured executable with the same safe guidance", () => {
  assert.throws(() => resolvePythonRuntime({
    env: { PYTHON: "/missing/python" },
    platform: "darwin",
    probe() { return { status: null, error: { code: "ENOENT" } }; },
  }), (error) => {
    assert.match(error.message, /Python 3\.11\+ is required/u);
    assert.equal(error.message.includes("ENOENT"), false);
    return true;
  });
});
