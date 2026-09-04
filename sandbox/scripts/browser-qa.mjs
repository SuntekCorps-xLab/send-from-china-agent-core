import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resetDemoSourcingState } from "../../governance-worker/src/sourcing.js";
import { resetTenantState } from "../../governance-worker/src/tenant.js";
import { startSandbox } from "../server.mjs";

const sandboxRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(sandboxRoot, "..");
const artifactRoot = resolve(process.env.AGENT_CORE_SANDBOX_QA_ARTIFACT_ROOT
  || resolve(sandboxRoot, ".wrangler/browser-qa"));
const toolRoot = resolve(process.env.SANDBOX_QA_NODE_MODULES
  || resolve(repositoryRoot, "hosted-sandbox/.wrangler/qa-tooling/node_modules"));
const requireTools = createRequire(resolve(toolRoot, "../package.json"));
const supportedBrowsers = ["chrome", "firefox", "webkit"];
const requestedBrowsers = String(process.env.AGENT_CORE_SANDBOX_QA_BROWSERS || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const browsers = requestedBrowsers.length > 0 ? requestedBrowsers : supportedBrowsers;
if (browsers.some((browser) => !supportedBrowsers.includes(browser)) || new Set(browsers).size !== browsers.length) {
  throw new TypeError("AGENT_CORE_SANDBOX_QA_BROWSERS must be a unique comma-separated subset of chrome,firefox,webkit.");
}
const viewports = [{ width: 1440, height: 1000 }, { width: 390, height: 844 }];
const scenarios = ["http-search", "search-v2", "mcp-list", "mcp-search", "sourcing-preview"];
const report = {
  suite: "agent-core-synthetic-sandbox-browser-qa",
  started_at: new Date().toISOString(),
  fixture_only: true,
  credentials_used: false,
  external_network_requests: 0,
  required_matrix: browsers.flatMap((browser) => viewports.map((viewport) => ({ browser, viewport }))),
  cases: [],
  blockers: [],
  tools: {},
};

await mkdir(artifactRoot, { recursive: true });

let playwright;
let axeSource;
try {
  playwright = requireTools("playwright-core");
  report.tools.playwright = requireTools("playwright-core/package.json").version;
  report.tools.axe = requireTools("axe-core/package.json").version;
  axeSource = await readFile(requireTools.resolve("axe-core/axe.min.js"), "utf8");
} catch {
  report.blockers.push("OFFLINE_QA_TOOLING_MISSING: provide playwright-core and axe-core through SANDBOX_QA_NODE_MODULES; this runner never installs or downloads dependencies.");
}

async function auditPage(page, result, viewport, state) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    outside: [...document.body.querySelectorAll("*")].filter((element) => {
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > innerWidth + 1))) return false;
      for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
        const overflowX = getComputedStyle(ancestor).overflowX;
        if (overflowX === "auto" || overflowX === "scroll") return false;
      }
      return true;
    }).map((element) => ({ tag: element.tagName, className: String(element.className || "") })),
  }));
  const violations = await page.evaluate(async () => {
    const scan = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    return scan.violations.map((finding) => ({
      id: finding.id,
      impact: finding.impact,
      targets: finding.nodes.map((node) => node.target),
    }));
  });
  const audit = { state, overflow, violations };
  result.audits.push(audit);
  assert.equal(overflow.scrollWidth, viewport.width, `${state}: document has horizontal overflow`);
  assert.deepEqual(overflow.outside, [], `${state}: visible content escaped the viewport without a scroll container`);
  return audit;
}

async function runCase(browser, browserName, viewport, baseUrl) {
  // Explicit test-only isolation: each browser/viewport exercises the same
  // production quota semantics from a fresh in-memory fixture state.
  resetDemoSourcingState();
  resetTenantState();
  const result = {
    browser: browserName,
    browser_version: browser.version(),
    viewport,
    status: "running",
    scenarios: [],
    console_errors: [],
    page_errors: [],
    unexpected_requests: [],
    audits: [],
  };
  report.cases.push(result);
  const context = await browser.newContext({
    viewport,
    locale: "en-US",
    reducedMotion: "no-preference",
    serviceWorkers: "block",
  });
  try {
    const page = await context.newPage();
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type())) {
        result.console_errors.push({ type: message.type(), text: message.text() });
      }
    });
    page.on("pageerror", (error) => result.page_errors.push(error.message));
    await page.route("**/*", async (route) => {
      const target = new URL(route.request().url());
      if (target.origin !== baseUrl) {
        result.unexpected_requests.push({ method: route.request().method(), origin: target.origin });
        report.external_network_requests += 1;
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await page.goto(`${baseUrl}/sandbox`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector("[data-runtime-title]")?.textContent.includes("ready"));
    await page.evaluate(axeSource);
    assert.equal(await page.locator("main").isVisible(), true);
    await auditPage(page, result, viewport, "initial");

    for (const scenario of scenarios) {
      await page.locator(`[data-scenario="${scenario}"]`).click();
      if (scenario === "sourcing-preview") await page.locator("[data-confirm-checkbox]").check();
      await page.locator("[data-run]").click();
      await page.waitForFunction(() => document.querySelector("[data-response-status]")?.textContent.includes("Success"));
      assert.equal(await page.locator("main").isVisible(), true, `${scenario}: main disappeared`);
      assert.ok(await page.locator("body").evaluate((element) => element.getBoundingClientRect().height > 400),
        `${scenario}: page became blank`);
      const responseText = await page.locator("[data-response-code]").innerText();
      assert.doesNotThrow(() => JSON.parse(responseText), `${scenario}: response is not JSON`);
      result.scenarios.push({ scenario, status: "passed", response_bytes: Buffer.byteLength(responseText) });
    }

    await auditPage(page, result, viewport, "after-all-clicks");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
    assert.deepEqual(result.console_errors, []);
    assert.deepEqual(result.page_errors, []);
    assert.deepEqual(result.unexpected_requests, []);
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = error.message;
  } finally {
    await context.close();
  }
}

const sandbox = await startSandbox({ port: 0 });
try {
  if (playwright) {
    for (const browserName of browsers) {
      let browser;
      try {
        browser = await (browserName === "chrome" ? playwright.chromium : playwright[browserName]).launch({
          headless: true,
          ...(browserName === "chrome" ? {
            channel: "chrome",
            args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"],
          } : {}),
        });
      } catch (error) {
        report.blockers.push(`${browserName.toUpperCase()}_RUNTIME_UNAVAILABLE: ${error.message.split("\n")[0]}`);
        for (const viewport of viewports) report.cases.push({ browser: browserName, viewport, status: "blocked" });
        continue;
      }
      try {
        for (const viewport of viewports) {
          await runCase(browser, browserName, viewport, sandbox.baseUrl);
          const result = report.cases.at(-1);
          console.log(`${result.status.toUpperCase()}: ${browserName} ${viewport.width}x${viewport.height}${result.error ? ` - ${result.error}` : ""}`);
        }
      } finally {
        await browser.close();
      }
    }
  }
} finally {
  await sandbox.close();
  report.completed_at = new Date().toISOString();
  report.passed = report.blockers.length === 0
    && report.cases.length === browsers.length * viewports.length
    && report.cases.every((result) => result.status === "passed"
      && result.scenarios?.length === scenarios.length)
    && report.external_network_requests === 0;
  const reportPath = resolve(artifactRoot, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`${report.passed ? "PASS" : "FAIL"}: ${relative(repositoryRoot, reportPath)}`);
  if (!report.passed) process.exitCode = 1;
}
