import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const indexHtml = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("the initial hosted shell does not claim catalog reads before readiness is verified", () => {
  assert.match(indexHtml, /Catalog connection and readiness are not verified/iu);
  assert.match(indexHtml, /Catalog reads are unavailable until/iu);
  assert.match(indexHtml, /Readiness not yet verified/iu);
  assert.match(indexHtml, /<span>Catalog reads<\/span><b class="off">UNAVAILABLE<\/b>/u);
  assert.doesNotMatch(indexHtml, /Live catalog facts/iu);
  assert.doesNotMatch(indexHtml, /<span>Catalog reads<\/span><b>ON<\/b>/u);
  assert.doesNotMatch(indexHtml, /inspect live public product fields/iu);
});

test("the connected-ready message remains behind the verified status guard", () => {
  const verifiedGuard = appSource.indexOf("if (!status.verified || status.writes !== false)");
  const readyMessage = appSource.indexOf("Connected. Published catalog reads are ready");
  assert.notEqual(verifiedGuard, -1);
  assert.notEqual(readyMessage, -1);
  assert.ok(verifiedGuard < readyMessage);
});
