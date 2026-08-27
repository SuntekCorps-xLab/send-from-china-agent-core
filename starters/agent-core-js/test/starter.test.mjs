import assert from "node:assert/strict";
import test from "node:test";

import { startSandbox } from "../../../sandbox/server.mjs";
import { searchSyntheticCatalog } from "../src/index.mjs";

test("starter reaches a real sandbox handler without a caller credential", async (context) => {
  const sandbox = await startSandbox({ port: 0 });
  context.after(() => sandbox.close());
  const result = await searchSyntheticCatalog("desk organizer", { baseUrl: sandbox.baseUrl });
  assert.equal(result.mode, "synthetic_local_sandbox");
  assert.equal(result.purchasable, false);
  assert.equal(result.items[0].slug, "modular-desk-organizer");
});
