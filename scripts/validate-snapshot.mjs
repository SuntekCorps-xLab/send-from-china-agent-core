import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { getSnapshotMeta, loadSnapshot } from "../governance-worker/src/snapshot.js";


const source = process.argv[2];
if (!source) {
  console.error(JSON.stringify({ error: { code: "MISSING_SNAPSHOT_PATH" } }));
  process.exit(2);
}

try {
  const raw = await readFile(resolve(source), "utf8");
  const snapshot = loadSnapshot(raw, { activate: false });
  const meta = getSnapshotMeta(snapshot);
  console.log(JSON.stringify({ ok: true, ...meta }));
} catch {
  console.error(JSON.stringify({ error: { code: "INVALID_SNAPSHOT" } }));
  process.exit(1);
}
