import { startSandbox } from "../sandbox/server.mjs";

const MAX_FRAME_BYTES = 32 * 1024;
const sandbox = await startSandbox({ port: 0 });
let queue = Promise.resolve();
let closing = false;
let pending = Buffer.alloc(0);
let discardingOversizeFrame = false;
let protocolVersion = "";

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function failure(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function relay(line) {
  if (!line.trim()) return;
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    writeMessage(failure(null, -32700, "Frame too large"));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    writeMessage(failure(null, -32700, "Parse error"));
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    writeMessage(failure(null, -32600, "Invalid Request"));
    return;
  }

  try {
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
    const response = await fetch(`${sandbox.baseUrl}/sandbox/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    if (response.status === 202 || response.status === 204) return;
    if (!text) {
      writeMessage(failure(payload && typeof payload === "object" ? payload.id : null, -32603, "Empty MCP response"));
      return;
    }
    const message = JSON.parse(text);
    if (payload.method === "initialize" && typeof message?.result?.protocolVersion === "string") {
      protocolVersion = message.result.protocolVersion;
    }
    writeMessage(message);
  } catch {
    const id = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.id : null;
    writeMessage(failure(id, -32603, "MCP bridge failure"));
  }
}

async function close(exitCode = 0) {
  if (closing) return;
  closing = true;
  await queue;
  await sandbox.close();
  process.exitCode = exitCode;
}

function enqueue(frame) {
  queue = queue.then(() => relay(frame)).catch(() => writeMessage(failure(null, -32603, "MCP bridge failure")));
}

function enqueueFailure(code, message) {
  queue = queue.then(() => writeMessage(failure(null, code, message)));
}

process.stdin.on("data", (chunk) => {
  let start = 0;
  while (start < chunk.length) {
    const newline = chunk.indexOf(0x0a, start);
    const end = newline === -1 ? chunk.length : newline;
    const segment = chunk.subarray(start, end);
    if (!discardingOversizeFrame) {
      if (pending.length + segment.length > MAX_FRAME_BYTES) {
        pending = Buffer.alloc(0);
        discardingOversizeFrame = true;
        enqueueFailure(-32700, "Frame too large");
      } else if (segment.length) {
        pending = Buffer.concat([pending, segment], pending.length + segment.length);
      }
    }
    if (newline === -1) break;
    if (!discardingOversizeFrame) {
      if (pending.at(-1) === 0x0d) pending = pending.subarray(0, pending.length - 1);
      enqueue(pending.toString("utf8"));
      pending = Buffer.alloc(0);
    } else {
      discardingOversizeFrame = false;
    }
    start = newline + 1;
  }
});
process.stdin.on("end", () => {
  if (!discardingOversizeFrame && pending.length) enqueue(pending.toString("utf8"));
  pending = Buffer.alloc(0);
  void close();
});
process.on("SIGINT", () => void close(130));
process.on("SIGTERM", () => void close(143));
