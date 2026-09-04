import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const verifier = fileURLToPath(new URL("./verify.mjs", import.meta.url));
const preloadSource = String.raw`
  import assert from "node:assert/strict";
  import childProcess from "node:child_process";
  import { existsSync, readdirSync, writeFileSync } from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  import { dirname, join } from "node:path";

  const parent = process.env.VERIFY_CLEANUP_FIXTURE;
  const scenario = process.env.VERIFY_CLEANUP_SCENARIO;
  const trace = { calls: [], temporary: null, publishedFiles: [] };
  process.on("exit", (code) => {
    writeFileSync(join(parent, "trace.json"), JSON.stringify({
      ...trace,
      exitCode: code,
      temporaryExistsAtExit: trace.temporary ? existsSync(trace.temporary) : false,
    }));
  });

  // Only child results are controlled. The orchestrator creates and removes real files.
  childProcess.spawnSync = (command, args) => {
    if (args[0] === "-c") return { status: 0, stdout: "3.12.0" };
    trace.calls.push(args);
    if (!trace.temporary) {
      const directories = readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("agent-core-")
          && entry.name !== "agent-core-sibling");
      assert.equal(directories.length, 1);
      trace.temporary = join(parent, directories[0].name);
    }
    if (scenario === "first-failure") return { status: 7 };
    if (scenario === "signal-failure") return { status: null, signal: "SIGTERM" };
    if (scenario === "spawn-error") return { error: new Error("Synthetic verification child launch failure") };
    if (args[0] === "publisher/build_snapshot.py") {
      for (const option of ["--output", "--report"]) {
        const target = args[args.indexOf(option) + 1];
        assert.equal(dirname(target), trace.temporary);
        writeFileSync(target, JSON.stringify({ synthetic: true }));
        trace.publishedFiles.push(target);
      }
    }
    if (scenario === "late-failure" && args[0] === "scripts/validate-snapshot.mjs") {
      assert.equal(trace.publishedFiles.length, 2);
      assert.ok(trace.publishedFiles.every((file) => existsSync(file)));
      return { status: 9 };
    }
    return { status: 0 };
  };
  syncBuiltinESMExports();
`;

for (const [scenario, expectedStatus] of [
  ["first-failure", 7],
  ["late-failure", 9],
  ["success", 0],
  ["spawn-error", 1],
  ["signal-failure", 1],
]) {
  test(`verification ${scenario} awaits cleanup and preserves its exit status`, async () => {
    const temporaryRoot = await realpath(tmpdir());
    const fixture = await mkdtemp(join(temporaryRoot, "agent-core-verify-cleanup-"));
    try {
      const sibling = join(fixture, "agent-core-sibling");
      await mkdir(sibling);
      await writeFile(join(sibling, "keep.txt"), "Synthetic sibling must remain intact.");
      const preload = join(fixture, "child-results.mjs");
      await writeFile(preload, preloadSource);
      const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, verifier], {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          TEMP: fixture,
          TMP: fixture,
          TMPDIR: fixture,
          VERIFY_CLEANUP_FIXTURE: fixture,
          VERIFY_CLEANUP_SCENARIO: scenario,
        },
        timeout: 10000,
        shell: false,
        windowsHide: true,
      });
      assert.ifError(result.error);
      assert.equal(result.status, expectedStatus, result.stderr);
      const trace = JSON.parse(await readFile(join(fixture, "trace.json"), "utf8"));
      assert.equal(trace.exitCode, expectedStatus);
      assert.equal(dirname(trace.temporary), fixture);
      assert.equal(await readFile(join(sibling, "keep.txt"), "utf8"), "Synthetic sibling must remain intact.");

      if (["first-failure", "spawn-error", "signal-failure"].includes(scenario)) {
        assert.equal(trace.calls.length, 1, "No later verification command may run after failure");
      } else {
        assert.equal(trace.publishedFiles.length, 2);
        assert.equal(trace.calls.at(-1)[0], scenario === "success"
          ? "scripts/scan-public.mjs" : "scripts/validate-snapshot.mjs");
      }
      assert.equal(result.stdout.includes("PASS: Agent Core verification"), scenario === "success");
      assert.equal(trace.temporaryExistsAtExit, false, "The invocation directory must be gone before process exit");
      await assert.rejects(access(trace.temporary), { code: "ENOENT" });
      for (const file of trace.publishedFiles) await assert.rejects(access(file), { code: "ENOENT" });
    } finally {
      assert.equal(dirname(fixture), temporaryRoot);
      await rm(fixture, { recursive: true, force: true });
    }
  });
}
