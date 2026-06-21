// Node.js HTTP entry. Adapts node:http <-> Web Fetch primitives so the
// same handler used by Cloudflare Workers can run as a plain local proxy.
//
// Usage:
//   node server.js
//   PORT=6008 node server.js
//
// Key sources (checked in priority order):
//   1. keys.txt file next to server.js — one key per line, round-robin per request
//   2. UNLIMITED_SURF_API_KEY / API_KEY / AUTH_KEY env vars
//   3. Remote fetch from https://unlimited.surf/api/key + periodic refresh
//
// Requirements: Node.js >= 18 (built-in fetch, Request, Response, ReadableStream).

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { handleRequest } from "./src/worker.js";

const PORT = Number(process.env.PORT) || 6008;
const HOST = process.env.HOST || "0.0.0.0";
const DEFAULT_KEY_SOURCE_URL = "https://unlimited.surf/api/key";
const KEY_REFRESH_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.KEY_REFRESH_INTERVAL_MS) || 60 * 60 * 1000,
);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.join(__dirname, "docs");
const KEYS_FILE_PATH = path.join(__dirname, "keys.txt");

// ── keys.txt round-robin pool ──────────────────────────────
let keyPool = [];          // non-empty when keys.txt is loaded
let keyPoolIndex = 0;      // current round-robin position

const STATIC_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
]);
const UI_AUTH_COOKIE = "transfer_api_worker_key";

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

function maskKey(key) {
  if (!key) return "(empty)";
  if (key.length <= 10) return `${key.slice(0, 3)}***`;
  return `${key.slice(0, 5)}***${key.slice(-4)}`;
}

function keySourceUrl() {
  return process.env.KEY_SOURCE_URL || DEFAULT_KEY_SOURCE_URL;
}

async function refreshUpstreamKey(reason = "scheduled") {
  const url = keySourceUrl();
  const response = await fetch(url, {
    headers: { "Accept": "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`key endpoint failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  if (!data || typeof data.key !== "string" || !data.key.trim()) {
    throw new Error("key endpoint did not return a valid JSON field: key");
  }

  process.env.UNLIMITED_SURF_API_KEY = data.key.trim();
  process.env.AUTO_FETCHED_UPSTREAM_KEY = "1";
  process.env.UPSTREAM_KEY_REFRESHED_AT = new Date().toISOString();

  console.log(
    `[key refresh] ${reason}: updated upstream key ${maskKey(process.env.UNLIMITED_SURF_API_KEY)}` +
    (data.limit ? `, limit=${data.limit}` : ""),
  );
  return data;
}

async function loadKeysTxt() {
  // Try loading keys from keys.txt file next to server.js.
  if (!existsSync(KEYS_FILE_PATH)) {
    console.log("[keys.txt] file not found, skipping.");
    return;
  }

  try {
    const raw = await readFile(KEYS_FILE_PATH, "utf8");
    const keys = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    if (keys.length === 0) {
      console.log("[keys.txt] file is empty (no non-comment lines), skipping.");
      return;
    }

    keyPool = keys;
    keyPoolIndex = 0;
    // Set the first key so worker.js can use it immediately.
    process.env.UNLIMITED_SURF_API_KEY = keyPool[0];
    process.env.KEY_SOURCE = "keys.txt";
    console.log(
      `[keys.txt] loaded ${keyPool.length} key(s) from keys.txt: ${keyPool.map(maskKey).join(', ')}`,
    );
    console.log(`[keys.txt] starting with key #1/${keyPool.length}: ${maskKey(process.env.UNLIMITED_SURF_API_KEY)}`);
  } catch (err) {
    console.error(`[keys.txt] failed to read keys.txt: ${err && err.message ? err.message : String(err)}`);
  }
}

// Called by worker.js when it actually needs an upstream key for an API call.
// Only rotates on real upstream usage — not on static/health/UI requests.
export function rotatePoolKey() {
  if (keyPool.length === 0) return null;
  keyPoolIndex = (keyPoolIndex + 1) % keyPool.length;
  const key = keyPool[keyPoolIndex];
  process.env.UNLIMITED_SURF_API_KEY = key;
  return key;
}

async function ensureInitialUpstreamKey() {
  // Priority 1: keys.txt file (round-robin, no remote fetch needed).
  await loadKeysTxt();
  if (keyPool.length > 0) {
    console.log("[key refresh] keys.txt loaded — remote key fetch and periodic refresh are disabled.");
    return;
  }

  // Priority 2: pre-configured env keys.
  if (process.env.UNLIMITED_SURF_API_KEY || process.env.API_KEY || process.env.AUTH_KEY) {
    console.log("[key refresh] startup: using configured upstream key; periodic refresh remains enabled.");
    return;
  }

  // Priority 3: fetch from remote endpoint.
  console.log(`[key refresh] startup: UNLIMITED_SURF_API_KEY not set, fetching from ${keySourceUrl()} ...`);
  await refreshUpstreamKey("startup");
}

function startKeyRefreshTimer() {
  // When keys.txt pool is active, no periodic remote refresh is needed.
  if (keyPool.length > 0) {
    console.log("[key refresh] periodic refresh disabled — keys.txt round-robin pool is active.");
    return;
  }

  if (String(process.env.AUTO_REFRESH_UPSTREAM_KEY || "true").toLowerCase() === "false") {
    console.log("[key refresh] periodic refresh disabled by AUTO_REFRESH_UPSTREAM_KEY=false.");
    return;
  }

  const timer = setInterval(async () => {
    try {
      await refreshUpstreamKey("scheduled");
    } catch (err) {
      console.error(`[key refresh] scheduled refresh failed: ${err && err.message ? err.message : String(err)}`);
    }
  }, KEY_REFRESH_INTERVAL_MS);

  // Do not keep the Node process alive only because of this timer.
  if (typeof timer.unref === "function") timer.unref();
  console.log(`[key refresh] periodic refresh every ${Math.round(KEY_REFRESH_INTERVAL_MS / 1000)} seconds.`);
}

function parseCookies(headerValue) {
  const cookies = new Map();
  for (const part of String(headerValue || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch (_) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function clientKeyFromCookie(req) {
  return parseCookies(req.headers.cookie).get(UI_AUTH_COOKIE) || "";
}

function isUiAuthenticated(req) {
  if (!process.env.WORKER_API_KEY) return true;
  return clientKeyFromCookie(req) === process.env.WORKER_API_KEY;
}

async function readNodeJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function tryServeUiAuth(req, res) {
  const url = new URL(buildRequestUrl(req));
  if (!url.pathname.startsWith("/ui-auth/")) return false;

  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");

  if (url.pathname === "/ui-auth/status" && req.method === "GET") {
    res.statusCode = 200;
    res.end(JSON.stringify({
      enabled: Boolean(process.env.WORKER_API_KEY),
      authenticated: isUiAuthenticated(req),
    }));
    return true;
  }

  if (url.pathname === "/ui-auth/verify" && req.method === "POST") {
    try {
      const body = await readNodeJson(req);
      const key = typeof body.key === "string" ? body.key : "";
      const ok = !process.env.WORKER_API_KEY || key === process.env.WORKER_API_KEY;
      res.statusCode = ok ? 200 : 401;
      if (ok && process.env.WORKER_API_KEY) {
        res.setHeader(
          "set-cookie",
          `${UI_AUTH_COOKIE}=${encodeURIComponent(key)}; Path=/; SameSite=Lax; Max-Age=2592000`,
        );
      }
      res.end(JSON.stringify({ ok, enabled: Boolean(process.env.WORKER_API_KEY) }));
    } catch (err) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }));
    }
    return true;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: "not_found" }));
  return true;
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

async function tryServeDocs(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const url = new URL(buildRequestUrl(req));
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  // Only expose the small static UI in docs/. API routes continue to be handled
  // by src/worker.js.
  if (!["/index.html", "/app.js", "/style.css", "/.nojekyll"].includes(pathname)) {
    return false;
  }

  const filePath = path.join(DOCS_DIR, pathname.slice(1));
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader("content-type", STATIC_TYPES.get(ext) || "application/octet-stream");
    res.setHeader("cache-control", "no-store");
    if (req.method === "HEAD") res.end();
    else res.end(body);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
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
    if (await tryServeUiAuth(req, res)) return;
    if (await tryServeDocs(req, res)) return;

    const fetchRequest = nodeRequestToFetchRequest(req);
    // Inject the pool rotation function so worker.js only rotates on actual
    // upstream API calls, not on every HTTP request.
    const env = { ...process.env, _rotatePoolKey: rotatePoolKey };
    const fetchResponse = await handleRequest(fetchRequest, env);
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

async function main() {
  try {
    await ensureInitialUpstreamKey();
  } catch (err) {
    console.error(`[key refresh] startup fetch failed: ${err && err.message ? err.message : String(err)}`);
    console.error("[key refresh] server will still start, but upstream API calls may fail until a key is available.");
  }

  startKeyRefreshTimer();

  server.listen(PORT, HOST, () => {
    const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
    console.log(`unlimited.surf transfer API listening on http://${displayHost}:${PORT}`);
    console.log(`Web UI:        http://${displayHost}:${PORT}/`);
    console.log(`Health check:  http://${displayHost}:${PORT}/health`);
    if (process.env.WORKER_API_KEY) {
      console.log("Worker auth is ENABLED. Clients must send the WORKER_API_KEY.");
    }
  });
}

main().catch((err) => {
  console.error("[startup error]", err);
  process.exit(1);
});
