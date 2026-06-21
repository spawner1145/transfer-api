// Static client for the GitHub Pages config helper page.
// Renders client snippets live and lets the user test their deployed proxy
// directly from the browser.

const $ = (id) => document.getElementById(id);

const baseUrlInput = $("baseUrl");
const apiKeyInput = $("apiKey");
const openaiModelInput = $("openaiModel");
const claudeModelInput = $("claudeModel");
const streamToggle = $("streamToggle");
const anthropicToggle = $("anthropicToggle");
const promptInput = $("promptInput");
const sendBtn = $("sendBtn");
const output = $("playgroundOutput");
const repoLink = $("repoLink");

// Best-effort: if hosted on github.io, derive the repo URL.
(function setRepoLink() {
  const host = location.hostname;
  const match = host.match(/^([^.]+)\.github\.io$/);
  if (!match) return;
  const owner = match[1];
  const segments = location.pathname.split("/").filter(Boolean);
  const repo = segments[0];
  if (repo) repoLink.href = `https://github.com/${owner}/${repo}`;
})();

// Persist form state so the snippets are useful after a refresh.
const STORAGE_KEY = "transfer-api-config-v1";
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.baseUrl) baseUrlInput.value = data.baseUrl;
    if (data.apiKey) apiKeyInput.value = data.apiKey;
    if (data.openaiModel) openaiModelInput.value = data.openaiModel;
    if (data.claudeModel) claudeModelInput.value = data.claudeModel;
  } catch (_) { /* ignore */ }
}
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      baseUrl: baseUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      openaiModel: openaiModelInput.value.trim(),
      claudeModel: claudeModelInput.value.trim(),
    }));
  } catch (_) { /* ignore */ }
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function renderSnippets() {
  const base = stripTrailingSlash(baseUrlInput.value) || "http://localhost:8787";
  const key = apiKeyInput.value || "<your key>";
  const openaiModel = openaiModelInput.value || "gateway-gpt-5-5";
  const claudeModel = claudeModelInput.value || "claude-opus-4-7-20260101";

  $("snippetOpenAIPy").textContent =
`from openai import OpenAI

client = OpenAI(
    base_url="${base}/v1",
    api_key="${key}",
)

resp = client.chat.completions.create(
    model="${openaiModel}",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)`;

  $("snippetCurlOpenAI").textContent =
`curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${openaiModel}","messages":[{"role":"user","content":"Hello"}]}'`;

  $("snippetCurlAnthropic").textContent =
`curl ${base}/v1/messages \\
  -H "x-api-key: ${key}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${claudeModel}","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'`;

  $("snippetClaudeCode").textContent =
`$env:ANTHROPIC_BASE_URL  = "${base}"
$env:ANTHROPIC_AUTH_TOKEN = "${key}"
$env:ANTHROPIC_API_KEY    = "${key}"
$env:ANTHROPIC_MODEL      = "${claudeModel}"
claude`;
}

[baseUrlInput, apiKeyInput, openaiModelInput, claudeModelInput].forEach((el) => {
  el.addEventListener("input", () => { renderSnippets(); saveState(); });
});

loadState();
renderSnippets();

// ---- Playground ----------------------------------------------------------

async function runOpenAI(base, key, model, prompt, useStream) {
  const url = `${base}/v1/chat/completions`;
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: useStream,
  };
  const headers = {
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

async function runAnthropic(base, key, model, prompt, useStream) {
  const url = `${base}/v1/messages`;
  const body = {
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
    stream: useStream,
  };
  const headers = {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

async function consumeStream(resp, isAnthropic, write) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        if (isAnthropic) {
          // Anthropic streaming uses content_block_delta with delta.text.
          const t = obj && obj.delta && obj.delta.text;
          if (typeof t === "string") write(t);
        } else {
          // OpenAI chat.completion.chunk: choices[0].delta.content.
          const choice = obj && obj.choices && obj.choices[0];
          const t = choice && choice.delta && choice.delta.content;
          if (typeof t === "string") write(t);
        }
      } catch (_) {
        // Ignore non-JSON keep-alives.
      }
    }
  }
}

function extractFinalText(obj, isAnthropic) {
  if (isAnthropic) {
    if (Array.isArray(obj.content)) {
      return obj.content.map((p) => p && p.text ? p.text : "").join("");
    }
    return JSON.stringify(obj, null, 2);
  }
  const choice = obj && obj.choices && obj.choices[0];
  if (choice && choice.message && typeof choice.message.content === "string") {
    return choice.message.content;
  }
  return JSON.stringify(obj, null, 2);
}

sendBtn.addEventListener("click", async () => {
  const base = stripTrailingSlash(baseUrlInput.value);
  const key = apiKeyInput.value.trim();
  const prompt = promptInput.value;
  const useStream = streamToggle.checked;
  const isAnthropic = anthropicToggle.checked;
  const model = isAnthropic
    ? (claudeModelInput.value || "claude-opus-4-7-20260101")
    : (openaiModelInput.value || "gateway-gpt-5-5");

  if (!base) {
    output.textContent = "Error: please set a Base URL first.";
    return;
  }

  output.textContent = "";
  sendBtn.disabled = true;
  let buffer = "";
  const write = (chunk) => {
    buffer += chunk;
    output.textContent = buffer;
  };

  try {
    const resp = isAnthropic
      ? await runAnthropic(base, key, model, prompt, useStream)
      : await runOpenAI(base, key, model, prompt, useStream);

    if (!resp.ok) {
      const errText = await resp.text();
      output.textContent = `HTTP ${resp.status}\n${errText}`;
      return;
    }

    const contentType = resp.headers.get("content-type") || "";
    if (useStream && contentType.includes("event-stream")) {
      await consumeStream(resp, isAnthropic, write);
      if (!buffer) output.textContent = "(empty stream)";
    } else {
      const data = await resp.json().catch(async () => await resp.text());
      if (typeof data === "string") {
        output.textContent = data;
      } else {
        output.textContent = extractFinalText(data, isAnthropic);
      }
    }
  } catch (err) {
    output.textContent = `Network error: ${err && err.message ? err.message : String(err)}\n\n` +
      "If you're testing from this GitHub Pages site, make sure your proxy is\n" +
      "reachable from the browser and that the Base URL uses https when this page\n" +
      "is served over https (mixed content is blocked).";
  } finally {
    sendBtn.disabled = false;
  }
});
