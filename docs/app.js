const $ = (id) => document.getElementById(id);

const STORAGE_KEY = "transfer-api-chat-ui-v2";
const DEFAULT_MODELS = {
  openai: ["gateway-gpt-5-5", "gateway-gpt-5", "gpt-4o", "gpt-4o-mini"],
  anthropic: ["claude-opus-4-7-20260101", "claude-sonnet-4-5-20250929", "claude-3-5-sonnet-latest"],
};

const els = {
  baseUrl: $("baseUrl"),
  apiKey: $("apiKey"),
  apiType: $("apiType"),
  modelSelect: $("modelSelect"),
  refreshModelsBtn: $("refreshModelsBtn"),
  streamToggle: $("streamToggle"),
  temperatureInput: $("temperatureInput"),
  maxTokensInput: $("maxTokensInput"),
  statusText: $("statusText"),
  chatMessages: $("chatMessages"),
  chatForm: $("chatForm"),
  messageInput: $("messageInput"),
  sendBtn: $("sendBtn"),
  clearChatBtn: $("clearChatBtn"),
};

let messages = [];
let models = { openai: [...DEFAULT_MODELS.openai], anthropic: [...DEFAULT_MODELS.anthropic] };
let sending = false;

function stripTrailingSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function currentBaseUrl() {
  return stripTrailingSlash(els.baseUrl.value) || window.location.origin;
}

function currentApiType() {
  return els.apiType.value === "anthropic" ? "anthropic" : "openai";
}

function currentModel() {
  return els.modelSelect.value || models[currentApiType()][0];
}

function authHeaders(apiType) {
  const key = els.apiKey.value.trim();
  if (apiType === "anthropic") {
    return {
      "x-api-key": key || "sk-no-key",
      "anthropic-version": "2023-06-01",
    };
  }
  return { Authorization: `Bearer ${key || "sk-no-key"}` };
}

function setStatus(text, kind = "") {
  els.statusText.textContent = text;
  els.statusText.className = `status ${kind}`.trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    if (state.baseUrl) els.baseUrl.value = state.baseUrl;
    if (state.apiKey) els.apiKey.value = state.apiKey;
    if (state.apiType) els.apiType.value = state.apiType;
    if (typeof state.stream === "boolean") els.streamToggle.checked = state.stream;
    if (state.temperature) els.temperatureInput.value = state.temperature;
    if (state.maxTokens) els.maxTokensInput.value = state.maxTokens;
    if (state.models && typeof state.models === "object") {
      models = {
        openai: Array.isArray(state.models.openai) && state.models.openai.length ? state.models.openai : [...DEFAULT_MODELS.openai],
        anthropic: Array.isArray(state.models.anthropic) && state.models.anthropic.length ? state.models.anthropic : [...DEFAULT_MODELS.anthropic],
      };
    }
    if (Array.isArray(state.messages)) messages = state.messages.filter(isValidMessage);
    renderModelOptions(state.selectedModels || {});
  } catch (_) {
    messages = [];
  }
}

function saveState() {
  try {
    const selectedModels = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}").selectedModels || {};
    selectedModels[currentApiType()] = currentModel();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      baseUrl: currentBaseUrl(),
      apiKey: els.apiKey.value.trim(),
      apiType: currentApiType(),
      stream: els.streamToggle.checked,
      temperature: els.temperatureInput.value,
      maxTokens: els.maxTokensInput.value,
      models,
      selectedModels,
      messages,
    }));
  } catch (_) { /* ignore */ }
}

function isValidMessage(message) {
  return message && ["user", "assistant", "system"].includes(message.role) && typeof message.content === "string";
}

function renderModelOptions(selectedModels = {}) {
  const apiType = currentApiType();
  const selected = selectedModels[apiType] || els.modelSelect.value || models[apiType][0];
  els.modelSelect.innerHTML = "";
  for (const model of models[apiType]) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    if (model === selected) option.selected = true;
    els.modelSelect.appendChild(option);
  }
}

function renderMessages() {
  if (!messages.length) {
    els.chatMessages.innerHTML = `
      <div class="empty-state">
        <strong>还没有聊天记录</strong>
        <span>选择模型后输入第一条消息，AI 会以流式方式回复。</span>
      </div>`;
    return;
  }

  els.chatMessages.innerHTML = messages.map((message, index) => `
    <article class="message ${message.role}" data-index="${index}">
      <div class="avatar">${message.role === "user" ? "你" : message.role === "assistant" ? "AI" : "S"}</div>
      <div class="bubble">
        <div class="message-meta">${message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : "系统"}</div>
        <div class="message-content">${escapeHtml(message.content)}</div>
      </div>
    </article>`).join("");
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function appendMessage(role, content) {
  messages.push({ role, content });
  renderMessages();
  saveState();
  return messages.length - 1;
}

function updateMessage(index, content) {
  if (!messages[index]) return;
  messages[index].content = content;
  const node = els.chatMessages.querySelector(`[data-index="${index}"] .message-content`);
  if (node) node.textContent = content;
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  saveState();
}

function buildRequestBody(apiType, promptMessages) {
  const temperature = Number(els.temperatureInput.value);
  const maxTokens = Math.max(1, Number(els.maxTokensInput.value) || 1024);
  const common = {
    model: currentModel(),
    messages: promptMessages,
    stream: els.streamToggle.checked,
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
  };
  if (apiType === "anthropic") {
    return { ...common, max_tokens: maxTokens };
  }
  return { ...common, max_tokens: maxTokens };
}

async function sendChat(prompt) {
  const apiType = currentApiType();
  const base = currentBaseUrl();
  const endpoint = apiType === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  const conversation = [...messages, { role: "user", content: prompt }].filter((m) => m.role !== "system");

  appendMessage("user", prompt);
  const assistantIndex = appendMessage("assistant", "");

  const response = await fetch(`${base}${endpoint}`, {
    method: "POST",
    headers: {
      ...authHeaders(apiType),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildRequestBody(apiType, conversation)),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}\n${text}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (els.streamToggle.checked && response.body && contentType.includes("event-stream")) {
    await consumeSse(response, apiType, (text) => updateMessage(assistantIndex, text));
    if (!messages[assistantIndex].content) updateMessage(assistantIndex, "(空响应)");
    return;
  }

  const data = await response.json().catch(async () => ({ raw: await response.text() }));
  updateMessage(assistantIndex, extractFinalText(data, apiType));
}

async function consumeSse(response, apiType, onText) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || "";

    for (const part of parts) {
      const dataLines = part.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

      for (const payload of dataLines) {
        if (!payload || payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          const delta = extractDeltaText(obj, apiType);
          if (delta) {
            fullText += delta;
            onText(fullText);
          }
        } catch (_) {
          // Ignore keep-alive or non-JSON SSE data.
        }
      }
    }
  }
}

function extractDeltaText(obj, apiType) {
  if (apiType === "anthropic") {
    if (obj?.type === "content_block_delta" && typeof obj?.delta?.text === "string") return obj.delta.text;
    if (typeof obj?.delta?.text === "string") return obj.delta.text;
    return "";
  }
  return obj?.choices?.[0]?.delta?.content || "";
}

function extractFinalText(obj, apiType) {
  if (obj.raw) return obj.raw;
  if (apiType === "anthropic") {
    if (Array.isArray(obj.content)) return obj.content.map((part) => part?.text || "").join("");
    return JSON.stringify(obj, null, 2);
  }
  return obj?.choices?.[0]?.message?.content || JSON.stringify(obj, null, 2);
}

async function refreshModels() {
  const apiType = currentApiType();
  const base = currentBaseUrl();
  setStatus("正在刷新模型...", "loading");
  els.refreshModelsBtn.disabled = true;

  try {
    const headers = apiType === "anthropic"
      ? { ...authHeaders(apiType), "anthropic-version": "2023-06-01" }
      : authHeaders(apiType);
    const response = await fetch(`${base}/v1/models`, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const ids = extractModelIds(data);
    if (!ids.length) throw new Error("模型接口未返回可识别的模型 id");
    models[apiType] = ids;
    renderModelOptions({ [apiType]: ids[0] });
    saveState();
    setStatus(`已加载 ${ids.length} 个模型`, "ok");
  } catch (error) {
    renderModelOptions();
    setStatus(`模型刷新失败，使用内置列表：${error.message}`, "error");
  } finally {
    els.refreshModelsBtn.disabled = false;
  }
}

function extractModelIds(data) {
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
  return [...new Set(list.map((item) => {
    if (typeof item === "string") return item;
    return item?.id || item?.name || item?.model;
  }).filter(Boolean))];
}

els.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (sending) return;

  const prompt = els.messageInput.value.trim();
  if (!prompt) return;

  sending = true;
  els.sendBtn.disabled = true;
  els.messageInput.value = "";
  setStatus("正在生成回复...", "loading");

  try {
    await sendChat(prompt);
    setStatus("回复完成", "ok");
  } catch (error) {
    appendMessage("assistant", `请求失败：\n${error.message}`);
    setStatus("请求失败", "error");
  } finally {
    sending = false;
    els.sendBtn.disabled = false;
    els.messageInput.focus();
  }
});

els.messageInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    els.chatForm.requestSubmit();
  }
});

els.clearChatBtn.addEventListener("click", () => {
  if (messages.length && !confirm("确定要清除当前浏览器中的聊天记录吗？")) return;
  messages = [];
  renderMessages();
  saveState();
  setStatus("聊天记录已清除", "ok");
});

els.refreshModelsBtn.addEventListener("click", refreshModels);
els.apiType.addEventListener("change", () => { renderModelOptions(); saveState(); });
[els.baseUrl, els.apiKey, els.modelSelect, els.streamToggle, els.temperatureInput, els.maxTokensInput].forEach((el) => {
  el.addEventListener("input", saveState);
  el.addEventListener("change", saveState);
});

loadState();
renderModelOptions();
renderMessages();
saveState();
