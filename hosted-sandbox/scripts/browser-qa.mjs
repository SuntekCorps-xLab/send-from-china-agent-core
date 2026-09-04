import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";
import { INVITE, DOMAIN, productNode, health, catalog, detail, jsonResponse, testEnv } from "../test/helpers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = resolve(root, ".wrangler/browser-qa");
const toolRoot = process.env.SANDBOX_QA_NODE_MODULES || resolve(root, ".wrangler/qa-tooling/node_modules");
const requireTools = createRequire(resolve(toolRoot, "../package.json"));
const origin = "https://sandbox.example";
const imageUrl = "https://cdn.shopify.com/s/files/1/demo-product.jpg";
const productHandle = `fixture-organizer-${"long".repeat(18)}`;
const fixtureProduct = () => productNode({
  handle: productHandle,
  title: `Recycled desk organizer ${"A".repeat(110)}`,
  description: "A public fixture for keyboard, image, price, material and model verification.",
  onlineStoreUrl: `https://shop.example/products/${productHandle}`,
  images: { nodes: [{ url: imageUrl, altText: "Green recycled desktop organizer" }] },
  options: [{ name: "Material", values: ["Recycled plastic"] }, { name: "Model", values: ["Desk-120"] }],
  productType: "Desk organizers",
});
const imageBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" fill="#e5ebe4"/><rect x="35" y="58" width="90" height="65" rx="12" fill="#47745c"/><path d="M45 90h70M75 63v54" stroke="#c2d7c7" stroke-width="5"/><path d="M49 39v28M62 29v38M95 42v25" stroke="#b77c48" stroke-width="9"/></svg>');
const assetNames = new Map([["/index.html", "text/html"], ["/app.js", "text/javascript"], ["/styles.css", "text/css"]]);
const assets = new Map(await Promise.all([...assetNames].map(async ([name, type]) => [name, {
  type, body: await readFile(resolve(root, `public${name}`)),
}])));
const browsers = ["chrome", "firefox", "webkit"];
const viewports = [{ width: 1440, height: 1000 }, { width: 390, height: 844 }];
const report = {
  suite: "hosted-sandbox-offline-browser-qa", started_at: new Date().toISOString(),
  fixture_only: true, production_credentials_used: false, runtime_dependencies_added: false,
  required_matrix: browsers.flatMap((browser) => viewports.map((viewport) => ({ browser, viewport }))),
  tools: {}, cases: [], blockers: [], external_network_requests: 0,
  csp_bypass_main: false,
  a11y_scope: "Real-CSP journey page; all WCAG A/AA rules enabled",
  screenshot_scope: "Chrome/Firefox: real-CSP page. WebKit: script-free same-DOM/viewport snapshot in isolated CSP-bypass context, with matching dimensions, because Playwright screenshot synchronization injects a stylesheet. Snapshot images are visual evidence only; all security/console/a11y checks run on the real-CSP page.",
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
  report.blockers.push("OFFLINE_QA_TOOLING_MISSING: provide existing playwright-core and axe-core through SANDBOX_QA_NODE_MODULES; this runner never installs or downloads dependencies.");
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  report.external_network_requests += 1;
  throw new Error("Unexpected non-injected Node fetch rejected");
};

async function runCase(browser, browserName, viewport) {
  const key = `${browserName}-${viewport.width}x${viewport.height}`;
  const result = {
    browser: browserName, browser_version: browser.version(), viewport, status: "running", checks: [],
    screenshots: [], a11y_violations: [], overflow_findings: [], console_errors: [],
    page_errors: [], screenshot_instrumentation_errors: [], reduced_motion: {}, browser_requests: [], upstream_fixture_operations: [],
    injected_browser_failures: 0, intercepted_cdn_image_requests: 0, unexpected_requests_blocked: 0, external_requests_sent: 0,
  };
  report.cases.push(result);
  let releaseHealth;
  const healthHeld = new Promise((resolveHealth) => { releaseHealth = resolveHealth; });
  const env = testEnv(async (url, init) => {
    assert.equal(new URL(url).hostname, DOMAIN, "Fixture fetch requires the dedicated synthetic domain");
    const requestBody = JSON.parse(init.body);
    result.upstream_fixture_operations.push(requestBody.operationName);
    switch (requestBody.operationName) {
      case "ShopifySandboxHealth":
        await healthHeld;
        return jsonResponse(health());
      case "ShopifySandboxCatalog": {
        const query = requestBody.variables.query || "";
        if (query.includes("no catalog match")) return jsonResponse(catalog([]));
        if (query.includes("partial catalog")) return jsonResponse(catalog([], { hasNextPage: true, endCursor: "fixture-next-page" }));
        return jsonResponse(catalog([fixtureProduct()]));
      }
      case "ShopifySandboxProduct":
        assert.equal(requestBody.variables.handle, productHandle);
        return jsonResponse(detail(fixtureProduct()));
      default: throw new Error("Unexpected fixture operation");
    }
  }, {
    ASSETS: { fetch: async (request) => {
      const asset = assets.get(new URL(request.url).pathname);
      return asset ? new Response(asset.body, { headers: { "content-type": asset.type } }) : new Response(null, { status: 404 });
    } },
  });
  const context = await browser.newContext({ viewport, locale: "en-US", reducedMotion: "no-preference", serviceWorkers: "block" });
  const screenshotContext = browserName === "webkit" ? await browser.newContext({ viewport, locale: "en-US", serviceWorkers: "block", bypassCSP: true }) : null;
  try {
    const handleRoute = async (route) => {
      const incoming = route.request();
      const url = new URL(incoming.url());
      result.browser_requests.push({ method: incoming.method(), path: url.origin === origin ? url.pathname : "fixture-cdn-image" });
      if (incoming.url() === imageUrl && incoming.resourceType() === "image") {
        result.intercepted_cdn_image_requests += 1;
        await route.fulfill({ status: 200, contentType: "image/svg+xml", body: imageBytes });
        return;
      }
      if (url.origin !== origin) {
        result.unexpected_requests_blocked += 1;
        await route.abort("blockedbyclient");
        return;
      }
      const headers = await incoming.allHeaders();
      assert.ok(!headers.authorization && !headers.cookie && !headers["x-shopify-storefront-access-token"]);
      const response = await worker.fetch(new Request(incoming.url(), {
        method: incoming.method(), headers,
        ...(incoming.postData() === null ? {} : { body: incoming.postData() }),
      }), env);
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    };
    await context.route("**/*", handleRoute);
    let screenshotPage;
    if (screenshotContext) {
      await screenshotContext.route("**/*", async (route) => {
        if (route.request().url() === origin + "/sandbox") {
          await route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><html lang="en"><head><title>QA visual snapshot</title></head><body></body></html>' });
          return;
        }
        await handleRoute(route);
      });
      screenshotPage = await screenshotContext.newPage();
      screenshotPage.on("console", (message) => {
        if (["warning", "error"].includes(message.type())) result.screenshot_instrumentation_errors.push(message.text());
      });
      await screenshotPage.goto(`${origin}/sandbox`, { waitUntil: "networkidle" });
    }
    const page = await context.newPage();
    screenshotPage ||= page;
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) result.console_errors.push({ type: message.type(), text: message.text() });
    });
    page.on("pageerror", (error) => result.page_errors.push(error.message));
    await page.goto(`${origin}/sandbox`, { waitUntil: "networkidle" });
    await page.evaluate(axeSource);

    async function audit(state) {
      const violations = await page.evaluate(async () => {
        const scan = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
        return scan.violations.map((finding) => ({ id: finding.id, impact: finding.impact, targets: finding.nodes.map((node) => node.target) }));
      });
      result.a11y_violations.push(...violations.map((finding) => ({ state, ...finding })));
      const overflow = await page.evaluate(() => {
        const outside = [...document.body.querySelectorAll("*")].filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
        }).map((element) => ({ tag: element.tagName, class: element.className, id: element.id }));
        return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, outside };
      });
      if (overflow.scrollWidth > viewport.width || overflow.outside.length) result.overflow_findings.push({ state, ...overflow });
      const screenshot = `${key}-${state}.png`;
      if (screenshotContext) {
        const snapshot = await page.evaluate(() => {
          const clone = document.documentElement.cloneNode(true);
          clone.querySelectorAll("script").forEach((element) => element.remove());
          clone.querySelectorAll("input").forEach((element) => {
            element.setAttribute("value", document.getElementById(element.id)?.value || "");
          });
          return {
            html: "<!doctype html>" + clone.outerHTML,
            width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
            reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "no-preference",
          };
        });
        await screenshotPage.emulateMedia({ reducedMotion: snapshot.reducedMotion });
        await screenshotPage.setContent(snapshot.html, { waitUntil: "networkidle" });
        const dimensions = await screenshotPage.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
        assert.deepEqual(dimensions, { width: snapshot.width, height: snapshot.height }, "Screenshot snapshot must preserve real-page geometry");
      }
      await screenshotPage.screenshot({ path: resolve(artifactRoot, screenshot), fullPage: true, caret: "initial", animations: "allow" });
      result.screenshots.push(screenshot);
      assert.equal(violations.length, 0, `${state}: accessibility violations`);
      assert.ok(overflow.scrollWidth <= viewport.width && overflow.outside.length === 0, `${state}: horizontal overflow`);
      result.checks.push(`${state}: WCAG A/AA scan and horizontal overflow`);
    }

    assert.equal(await page.locator("#source").innerText(), "Not connected");
    await audit("initial");
    await page.getByLabel("Product request").fill("fixture organizer");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    assert.equal(await page.locator("#status-text").innerText(), "Connect with a preview invite before searching.");
    assert.equal(await page.locator("#invite").evaluate((element) => document.activeElement === element), true);
    assert.equal(result.upstream_fixture_operations.length, 0);
    result.checks.push("Search before invite is rejected without provider access and returns keyboard focus");

    await page.getByLabel("Preview invite").fill(INVITE);
    await page.getByLabel("Preview invite").press("Enter");
    await page.waitForFunction(() => document.querySelector("#status-dot").dataset.state === "loading");
    result.reduced_motion.no_preference_loading_animation = await page.locator("#status-dot").evaluate((element) => getComputedStyle(element).animationName);
    assert.notEqual(result.reduced_motion.no_preference_loading_animation, "none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    result.reduced_motion.reduce_loading_animation = await page.locator("#status-dot").evaluate((element) => getComputedStyle(element).animationName);
    assert.equal(result.reduced_motion.reduce_loading_animation, "none");
    assert.equal(await page.locator("#invite").inputValue(), "");
    releaseHealth();
    await page.waitForFunction(() => document.querySelector("#status-text").textContent.startsWith("Connected."));
    assert.equal(await page.locator("#query").evaluate((element) => document.activeElement === element), true);
    assert.equal(await page.locator("#source").innerText(), "Shopify published catalog");
    result.checks.push("Status uses injected fetch; keyboard submit clears invite and focuses search; reduced motion removes loading animation");
    await audit("connected");

    await page.getByLabel("Product request").fill("fixture organizer");
    await page.getByLabel("Product request").press("Enter");
    await page.waitForFunction(() => document.querySelector("#result-count").textContent === "1 result");
    const image = page.getByRole("img", { name: "Green recycled desktop organizer" });
    await image.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector(".product-image")?.naturalWidth > 0);
    assert.equal(await image.getAttribute("src"), imageUrl);
    assert.match(await page.locator(".product-card").innerText(), /\$19\.95/u);
    assert.equal(await page.locator(".product-handle").innerText(), `Handle: ${productHandle}`);
    assert.match(await page.locator(".product-attributes").innerText(), /Recycled plastic/u);
    assert.match(await page.locator(".product-attributes").innerText(), /Desk-120/u);
    assert.equal(await page.locator(".product-card button").evaluate((element) => element.getBoundingClientRect().height >= 44), true);
    await audit("results");
    await page.locator(".product-card button").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#status-text").textContent.includes("was verified through the read-only BFF"));
    assert.equal(await page.locator(".product-card button").isEnabled(), true);
    result.checks.push("Search and detail preserve allowlisted images/alt, long handle/title, price, material/model and 44px keyboard target");
    await audit("detail");

    await page.getByLabel("Product request").fill("no catalog match");
    await page.getByLabel("Product request").press("Enter");
    await page.waitForFunction(() => document.querySelector("#results").textContent.includes("No published match"));
    await audit("no-match");
    await page.getByLabel("Product request").fill("partial catalog");
    await page.getByLabel("Product request").press("Enter");
    await page.waitForFunction(() => document.querySelector("#status-text").textContent.startsWith("Search incomplete."));
    assert.doesNotMatch(await page.locator("#results").innerText(), /No published match/u);
    await audit("degraded");
    result.checks.push("Incomplete catalog results remain degraded and never display a terminal no-match claim");
    // Reject fetch in memory to exercise failure presentation without a network error or external request.
    async function injectReadFailure(pathname) {
      await page.evaluate((target) => {
        const original = window.fetch;
        window.fetch = (...args) => {
          if (new URL(args[0], window.location.origin).pathname === target) {
            window.fetch = original;
            return Promise.reject(new Error("OFFLINE_FIXTURE_FAILURE"));
          }
          return original(...args);
        };
      }, pathname);
      result.injected_browser_failures += 1;
    }
    async function assertUnavailable(state) {
      assert.equal(await page.locator("#source").innerText(), "Not connected");
      assert.match(await page.locator(".boundary").innerText(), /readiness unverified/u);
      assert.equal(await page.locator(".truth-row b").first().textContent(), "UNAVAILABLE");
      assert.equal(await page.locator("#invite").evaluate((element) => document.activeElement === element), true);
      assert.equal(await page.locator(".product-card").count(), 0);
      await audit(state);
    }
    await injectReadFailure("/sandbox/api/search/v2");
    await page.getByLabel("Product request").fill("fixture organizer");
    await page.getByLabel("Product request").press("Enter");
    await page.waitForFunction(() => document.querySelector("#status-text").textContent.startsWith("Search unavailable:"));
    await assertUnavailable("search-unavailable");
    await page.getByLabel("Preview invite").fill(INVITE);
    await page.getByLabel("Preview invite").press("Enter");
    await page.waitForFunction(() => document.querySelector("#status-text").textContent.startsWith("Connected."));
    await page.getByLabel("Product request").press("Enter");
    await page.waitForFunction(() => document.querySelector("#result-count").textContent === "1 result");
    await injectReadFailure(`/sandbox/api/products/${productHandle}`);
    await page.locator(".product-card button").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#status-text").textContent.startsWith("Detail unavailable:"));
    await assertUnavailable("detail-unavailable");
    result.checks.push("Injected search/detail failures clear stale readiness and results, returning keyboard focus to invite");
    assert.equal(result.console_errors.length, 0, "Unexpected browser console warnings/errors");
    assert.equal(result.screenshot_instrumentation_errors.length, 0, "Screenshot instrumentation errors");
    assert.equal(result.page_errors.length, 0, "Unexpected page errors");
    assert.equal(result.unexpected_requests_blocked, 0, "Unapproved browser request attempted");
    assert.ok(result.intercepted_cdn_image_requests > 0, "Real image rendering must be exercised");
    assert.ok(result.browser_requests.some((request) => request.method === "GET" && request.path === "/sandbox/status"));
    assert.ok(result.browser_requests.some((request) => request.method === "POST" && request.path === "/sandbox/api/search/v2"));
    assert.ok(result.browser_requests.some((request) => request.method === "GET" && request.path === `/sandbox/api/products/${productHandle}`));
    result.checks.push("Three hosted routes exercised with zero console errors, unapproved browser requests or external network sends");
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = error.message;
  } finally {
    releaseHealth();
    await context.close();
    await screenshotContext?.close();
  }
}

try {
  if (playwright) for (const browserName of browsers) {
    let browser;
    try {
      browser = await (browserName === "chrome" ? playwright.chromium : playwright[browserName]).launch({
        headless: true,
        ...(browserName === "chrome" ? { channel: "chrome", args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"] } : {}),
      });
    } catch (error) {
      report.blockers.push(`${browserName.toUpperCase()}_RUNTIME_UNAVAILABLE: ${error.message.split("\n")[0]}`);
      for (const viewport of viewports) report.cases.push({ browser: browserName, viewport, status: "blocked" });
      continue;
    }
    try {
      for (const viewport of viewports) {
        await runCase(browser, browserName, viewport);
        const current = report.cases.at(-1);
        console.log(`${current.status.toUpperCase()}: ${browserName} ${viewport.width}x${viewport.height}${current.error ? ` - ${current.error}` : ""}`);
      }
    } finally { await browser.close(); }
  }
} finally {
  globalThis.fetch = originalFetch;
  report.completed_at = new Date().toISOString();
  report.passed = report.blockers.length === 0 && report.cases.length === 6
    && report.cases.every((result) => result.status === "passed") && report.external_network_requests === 0;
  await writeFile(resolve(artifactRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.passed ? "PASS" : "FAIL"}: ${relative(root, resolve(artifactRoot, "report.json"))}`);
  if (!report.passed) process.exitCode = 1;
}