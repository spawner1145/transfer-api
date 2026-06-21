// Node.js HTTP entry. Adapts node:http <-> Web Fetch primitives so the
// same handler used by Cloudflare Workers can run as a plain local proxy.
//
// Usage:
//   node server.js
//   PORT=6008 UNLIMITED_SURF_API_KEY=sk-... node server.js
//
// Requirements: Node.js >= 18 (built-in fetch, Request, Response, ReadableStream).

import http from "node:http";
import { Readable } from "node:stream";
import { handleRequest } from "./src/worker.js";

const PORT = Number(process.env.PORT) || 6008;
const HOST = process.env.HOST || "0.0.0.0";

// Verify the runtime exposes the Web fetch primitives we rely on.
for (const name of ["fetch", "Request", "Response", "ReadableStream"]) {
  if (typeof globalThis[name] === "undefined") {
    console.error(`This server requires Node.js >= 18 (missing global: ${name}).`);
    process.exit(1);
  }
}

function buildRequestUrl(req) {
  const forwardedProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim();
  const proto = forwardedProto || (req.socket && req.socket.encrypted ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}${req.url}`;
}

function nodeRequestToFetchRequest(req) {
  const url = buildRequestUrl(req);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else {
      headers.set(name, String(value));
    }
  }

  const method = req.method || "GET";
  const init = { method, headers };

  if (method !== "GET" && method !== "HEAD") {
    // Stream the body instead of buffering it so SSE/large uploads keep working.
    init.body = Readable.toWeb(req);
    // Required by undici when sending a streaming body.
    init.duplex = "half";
  }

  return new Request(url, init);
}

async function writeFetchResponseToNode(fetchResponse, res) {
  res.statusCode = fetchResponse.status;
  // statusMessage is optional; leaving the default keeps things simple.

  for (const [key, value] of fetchResponse.headers) {
    // Hop-by-hop headers are not meaningful for a downstream proxy response.
    if (key.toLowerCase() === "content-length") continue;
    res.setHeader(key, value);
  }

  if (!fetchResponse.body) {
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(fetchResponse.body);
  nodeStream.on("error", (err) => {
    console.error("[stream error]", err);
    if (!res.headersSent) res.statusCode = 502;
    res.end();
  });
  nodeStream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const fetchRequest = nodeRequestToFetchRequest(req);
    const fetchResponse = await handleRequest(fetchRequest, process.env);
    await writeFetchResponseToNode(fetchResponse, res);
  } catch (err) {
    console.error("[handler error]", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
    }
    res.end(JSON.stringify({
      error: {
        message: err && err.message ? err.message : String(err),
        type: "internal_error",
        code: "internal_error",
      },
    }));
  }
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`unlimited.surf transfer API listening on http://${displayHost}:${PORT}`);
  console.log(`Health check:  http://${displayHost}:${PORT}/health`);
  if (!process.env.UNLIMITED_SURF_API_KEY && !process.env.API_KEY && !process.env.AUTH_KEY) {
    console.log("Note: UNLIMITED_SURF_API_KEY not set. Clients must pass their own upstream key on every request.");
  }
  if (process.env.WORKER_API_KEY) {
    console.log("Worker auth is ENABLED. Clients must send the WORKER_API_KEY.");
  }
});
