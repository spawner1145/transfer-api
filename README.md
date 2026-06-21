# Transfer unlimited.surf API

中文 | [English](#english)

这是一个把 `https://unlimited.surf` 转成 **OpenAI 兼容 / Anthropic（Claude Code）兼容** 接口的中转代理。

✨ **本仓库零运行时依赖**：核心代码只使用 Web 标准的 Fetch API（Node.js 18+ 原生支持），可以跑在：

- **本地 Node.js**（推荐，最简单）：`node server.js`
- **Docker**：仓库根目录的 `Dockerfile`
- **任何支持 Node 的 PaaS**：Render / Railway / Fly.io / Koyeb / Vercel …
- **Cloudflare Workers**（可选，仍然支持但不再强制）：`npx wrangler deploy`
- **GitHub Pages**：仅托管静态的"客户端配置助手 + Playground 页面"（详见后文）

## 功能概览

- **OpenAI 兼容**：`/v1/chat/completions`、`/v1/responses`、`/v1/models`、`/v1/files`、`/v1/search`、`/v1/merge`
- **Anthropic 兼容**：`/v1/messages`、`/v1/models`、`/anthropic/v1/messages`、`/anthropic/v1/models`
- **原始上游代理**：`/api/*` 直接转发
- **Web Search / Merge AI / Files Extract** 全部映射到上游对应接口
- **Setup / Codex / MCP 说明端点**：`/v1/setup`、`/v1/codex`、`/v1/mcp`

> 注意：MCP server 始终在客户端 / IDE / Claude Code / Codex 这一侧运行。本代理只提供模型 API 端点，不会读取或修改你本地的文件。

---

## 方式一：本地直接跑（推荐）

需要 Node.js **18 或以上**。无需 `npm install`，无需任何打包。

```bash
git clone https://github.com/<you>/transfer-api.git
cd transfer-api

# Linux / macOS
UNLIMITED_SURF_API_KEY=<你的 unlimited.surf key> \
WORKER_API_KEY=<可选，自定义的客户端 key> \
node server.js
```

```powershell
# Windows PowerShell
$env:UNLIMITED_SURF_API_KEY = "<你的 unlimited.surf key>"
$env:WORKER_API_KEY         = "<可选，自定义的客户端 key>"
node server.js
```

默认监听 `http://localhost:6008`。可用环境变量：

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | `6008` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `UNLIMITED_SURF_API_KEY` | 上游真实 key；不填时启动时自动从 `https://unlimited.surf/api/key` 获取 | 自动获取 |
| `WORKER_API_KEY` | 启用客户端鉴权后，调用方必须发送的 key | 无（关闭鉴权） |
| `UPSTREAM_BASE_URL` | 上游地址 | `https://unlimited.surf` |
| `KEY_SOURCE_URL` | 自动获取 key 的地址 | `https://unlimited.surf/api/key` |
| `KEY_REFRESH_INTERVAL_MS` | 后台刷新 key 的间隔，最小 60000ms | `3600000` |
| `AUTO_REFRESH_UPSTREAM_KEY` | 是否启用后台定时刷新；设为 `false` 可关闭 | `true` |
| `DEFAULT_MODEL` | OpenAI 路径默认模型 | `gateway-gpt-5-5` |
| `DEFAULT_CLAUDE_MODEL` | Anthropic 路径默认模型 | `claude-opus-4-7-20260101` |

验证：

```bash
curl http://localhost:6008/health
curl http://localhost:6008/v1/models -H "Authorization: Bearer <你的客户端 key；未设置 WORKER_API_KEY 时可填任意值>"
```

> 如果没有设置 `UNLIMITED_SURF_API_KEY`，服务会在启动时自动请求 `https://unlimited.surf/api/key`，读取返回 JSON 中的 `key` 字段作为上游 key；之后每隔 1 小时自动刷新一次并更新后台使用的 key。

---

## 方式二：Docker

```bash
docker build -t transfer-api .
docker run -d --name transfer-api -p 6008:6008 \
  -e UNLIMITED_SURF_API_KEY=<你的 unlimited.surf key> \
  -e WORKER_API_KEY=<可选> \
  transfer-api
```

镜像里不会安装任何 npm 包；它只用 Node 内置模块和 Web Fetch 原语。

---

## 方式三：部署到 PaaS（Render / Railway / Fly.io / Koyeb 等）

通用配置：

- **Build command**：留空（不需要构建）
- **Start command**：`node server.js`
- **Port**：读取 `$PORT`，所以平台分配什么端口都行
- **Environment variables**：至少配置 `UNLIMITED_SURF_API_KEY`，推荐再加 `WORKER_API_KEY`

部署完拿到的域名（例如 `https://your-app.onrender.com`）就是你的 base URL。

---

## 方式四：GitHub Pages（仅前端配置助手）

GitHub Pages 是**纯静态托管**，无法运行后端代理。因此本仓库的 GitHub Pages 站点只是一个**配置助手 + 浏览器 Playground**：

- 输入你的 base URL + key，自动生成 OpenAI / Anthropic / Claude Code 的配置片段。
- 直接在浏览器里向你部署好的后端发请求测试（支持 streaming）。

启用方式：

1. Fork / push 本仓库到你自己的 GitHub。
2. Settings → Pages → Source 选择 **GitHub Actions**。
3. 推一次代码，仓库里附带的 `.github/workflows/pages.yml` 会把 `docs/` 自动部署到 Pages。
4. 访问 `https://<你的用户名>.github.io/<仓库名>/`。

> 提示：GitHub Pages 是 HTTPS，浏览器会拒绝从 HTTPS 页面调 HTTP 后端（mixed content）。所以如果想用 Playground 页面测试，你的后端要么放在本地用 `http://localhost:6008`（同源 / localhost 例外），要么放在有 HTTPS 的平台上（Render / Fly.io / Cloudflare 等都自带 HTTPS）。

---

## 方式五：Cloudflare Workers（仍然支持，但已不强制）

如果你喜欢原来的 Workers 部署方式，仓库依然保留：

```bash
npm install -g wrangler   # 或者 npx wrangler ...
wrangler login
wrangler secret put UNLIMITED_SURF_API_KEY
wrangler secret put WORKER_API_KEY
wrangler deploy
```

`wrangler` 现在是 `optionalDependencies`，不装也能跑（本地 Node 模式根本用不到它）。

---

## 客户端 key 规则

```
设置了 WORKER_API_KEY：
  客户端必须传 WORKER_API_KEY
  代理用 UNLIMITED_SURF_API_KEY 请求 unlimited.surf

没有设置 WORKER_API_KEY：
  客户端传任意 key 都可以
  代理优先用 UNLIMITED_SURF_API_KEY；如果也没设，就把客户端传的 key 当作上游 key
```

---

## OpenAI 兼容接口示例

```bash
curl http://localhost:6008/v1/chat/completions \
  -H "Authorization: Bearer <你的客户端 key；未设置 WORKER_API_KEY 时可填任意值>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gateway-gpt-5","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

支持：`GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/search`、`POST /v1/merge`、`GET /v1/key`、`GET /v1/usage`、`POST /v1/files`、`POST /v1/files/extract`、`POST /v1/attachments/extract`、`GET /v1/setup`、`GET /v1/codex`、`GET /v1/mcp`。

## Anthropic / Claude Code 兼容

```powershell
$env:ANTHROPIC_BASE_URL  = "http://localhost:6008"
$env:ANTHROPIC_AUTH_TOKEN = "<你的 key>"
$env:ANTHROPIC_API_KEY    = "<你的 key>"
$env:ANTHROPIC_MODEL      = "claude-opus-4-7-20260101"
claude
```

## 功能映射

- Chat → 上游 `POST /api/chat`
- Web Search（`/v1/search`、`web_search_options`、`query`、web search tool）→ `POST /api/search`
- Merge AI（`/v1/merge`、`merge: true`、`models` ≥ 2）→ `POST /api/merge`
- Models → 上游 `GET /api/models`（失败时返回内置 fallback）
- Files → `POST /api/attachments/extract`
- Embeddings / audio / images → 返回 `501`，上游没有原生接口

---

## English

A proxy that exposes `https://unlimited.surf` as OpenAI-compatible and Anthropic/Claude-Code-compatible APIs.

✨ **Zero runtime dependencies.** The core uses only Web Fetch primitives (built into Node 18+), so it can run on:

- **Local Node.js** (recommended): `node server.js`
- **Docker**: see the `Dockerfile`
- **Any Node-friendly PaaS**: Render / Railway / Fly.io / Koyeb / Vercel / …
- **Cloudflare Workers** (still supported, no longer required): `npx wrangler deploy`
- **GitHub Pages**: static config-helper + browser Playground only (see below)

### Quick start — local

```bash
git clone https://github.com/<you>/transfer-api.git
cd transfer-api
UNLIMITED_SURF_API_KEY=<your key> node server.js
# Listens on http://localhost:6008
```

Environment variables: `PORT`, `HOST`, `UNLIMITED_SURF_API_KEY`, `WORKER_API_KEY`, `UPSTREAM_BASE_URL`, `DEFAULT_MODEL`, `DEFAULT_CLAUDE_MODEL`.

### Docker

```bash
docker build -t transfer-api .
docker run -p 6008:6008 -e UNLIMITED_SURF_API_KEY=<your key> transfer-api
```

### PaaS

Build command: empty. Start command: `node server.js`. Set env vars in the platform UI.

### GitHub Pages (static helper only)

The site under `docs/` is a config helper + browser playground that talks to whatever proxy URL you give it. Enable Pages in repo Settings → Pages → Source: GitHub Actions; the bundled workflow deploys it automatically. Note: an HTTPS Pages site cannot talk to an HTTP backend (mixed content), so host the proxy on HTTPS or test against `http://localhost:6008` from a locally-served copy.

### Cloudflare Workers (optional)

```bash
npx wrangler login
npx wrangler secret put UNLIMITED_SURF_API_KEY
npx wrangler secret put WORKER_API_KEY
npx wrangler deploy
```

### Routes

OpenAI: `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/search`, `/v1/merge`, `/v1/files*`.
Anthropic: `/v1/messages`, `/v1/models`, plus `/anthropic/*` aliases.
Raw upstream: any `/api/*` is forwarded with the configured key.
