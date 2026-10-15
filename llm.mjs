import fs from "node:fs";
import path from "node:path";

const OLLAMA_DOWN = "連唔到 Ollama（127.0.0.1:11434）";
const OWUI_KEY = "Open WebUI 要 API key";
const OWUI_URL_REQUIRED = "要有 Open WebUI 網址";
const OWUI_URL_BAD = "Open WebUI 網址唔啱";
const MODEL_TIMEOUT = "模型回逾時";
const MODEL_BAD = "模型回錯誤";

export function classifyHttpError(status) {
  return "模型回錯誤（HTTP " + status + "）";
}

export function stripSecret(text, apiKey) {
  let s = String(text == null ? "" : text);
  const key = String(apiKey || "").trim();
  if (key.length >= 8 && s.includes(key)) s = s.split(key).join("***");
  return s;
}

export function transportError(err, downLabel, apiKey) {
  if (err && err.name === "AbortError") return MODEL_TIMEOUT;
  const code = err && (err.code || (err.cause && err.cause.code));
  const msg = String((err && err.message) || "");
  const down = code === "ECONNREFUSED" || code === "ENOTFOUND" || /fetch failed|ECONNREFUSED/i.test(msg);
  return stripSecret(down ? downLabel : MODEL_BAD, apiKey);
}

export function httpStatusError(status, backend, apiKey) {
  if (backend === "openwebui" && (status === 401 || status === 403)) return OWUI_KEY;
  return stripSecret(classifyHttpError(status), apiKey);
}

export function downMessageFor(backend, endpoint) {
  if (backend === "openwebui") {
    const ep = String(endpoint || "").trim();
    return ep ? "連唔到 Open WebUI（" + ep + "）" : "連唔到 Open WebUI";
  }
  return OLLAMA_DOWN;
}

export function normalizeOpenWebUIUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: false, error: OWUI_URL_REQUIRED };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: OWUI_URL_BAD };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: OWUI_URL_BAD };
  if (u.username || u.password || u.search || u.hash) return { ok: false, error: OWUI_URL_BAD };
  const pathname = u.pathname.replace(/\/+$/, "");
  return { ok: true, url: u.origin + pathname };
}

export function endpointFromUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function authHeaders(apiKey) {
  const headers = { "content-type": "application/json" };
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (key) headers.authorization = "Bearer " + key;
  return headers;
}

export function isEmbedModelName(name, embedModel) {
  const n = String(name || "");
  const embed = String(embedModel || "");
  if (!embed) return false;
  return n === embed || n.startsWith(embed + ":");
}

export function modelNamesFromPayload(data) {
  const rows = Array.isArray(data)
    ? data
    : (data && Array.isArray(data.data) ? data.data
      : (data && Array.isArray(data.models) ? data.models : []));
  const out = [];
  for (const row of rows) {
    let name = "";
    if (typeof row === "string") name = row.trim();
    else if (row && row.id != null && String(row.id).trim()) name = String(row.id).trim();
    else if (row && row.name != null) name = String(row.name).trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

export function contentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) return content.map(contentText).join("");
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
  }
  return "";
}

export function parseChatContent(data) {
  if (!data || typeof data !== "object") return "";
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  if (choice && choice.message) return contentText(choice.message.content);
  if (data.message) return contentText(data.message.content);
  return "";
}

export function vectorFromEmbeddingPayload(data) {
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.data) && data.data[0] && Array.isArray(data.data[0].embedding) && data.data[0].embedding.length) {
    return data.data[0].embedding;
  }
  if (Array.isArray(data.embeddings) && Array.isArray(data.embeddings[0]) && data.embeddings[0].length) {
    return data.embeddings[0];
  }
  if (Array.isArray(data.embedding) && data.embedding.length) {
    if (typeof data.embedding[0] === "number") return data.embedding;
    if (Array.isArray(data.embedding[0]) && data.embedding[0].length) return data.embedding[0];
  }
  return null;
}

export function openWebUIChatBody({ model, messages, maxTokens }) {
  return {
    model,
    messages,
    stream: false,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
  };
}

export function ollamaChatBody({ model, messages, numPredict }) {
  return {
    model,
    stream: false,
    format: "json",
    messages,
    options: { num_predict: numPredict },
  };
}

export function embeddingCalls(model, input) {
  return [
    { path: "/api/embeddings", body: { model, input } },
    { path: "/ollama/api/embed", body: { model, input } },
    { path: "/ollama/v1/embeddings", body: { model, input } },
    { path: "/ollama/api/embeddings", body: { model, prompt: input } },
  ];
}

function positiveMs(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function embedModelFor(backend, env) {
  const e = env || {};
  if (backend === "openwebui") {
    return String(e.OPENWEBUI_EMBED || e.OLLAMA_EMBED || "nomic-embed-text").trim() || "nomic-embed-text";
  }
  return String(e.OLLAMA_EMBED || "nomic-embed-text").trim() || "nomic-embed-text";
}

function ollamaBase(env) {
  const raw = String((env && env.OLLAMA_URL) || "http://127.0.0.1:11434").trim() || "http://127.0.0.1:11434";
  return raw.replace(/\/$/, "");
}

export function createLlm({ dataDir, env, fetchImpl } = {}) {
  const fetchFn = fetchImpl || fetch;
  const file = path.join(dataDir, "llm.json");

  function readSaved() {
    try {
      const s = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!s || typeof s !== "object" || Array.isArray(s)) return null;
      return s;
    } catch {
      return null;
    }
  }

  function readConfig() {
    const e = env || {};
    const saved = readSaved();
    const useFile = !!saved;
    const backend = (useFile ? saved.backend : e.LLM_BACKEND) === "openwebui" ? "openwebui" : "ollama";
    let url = "";
    let urlError = null;
    const rawUrl = useFile ? saved.url : e.OPENWEBUI_URL;
    if (backend === "openwebui" || (rawUrl && String(rawUrl).trim())) {
      const n = normalizeOpenWebUIUrl(rawUrl || "");
      if (n.ok) url = n.url;
      else if (backend === "openwebui") urlError = n.error;
    }
    const apiKey = String((useFile ? saved.apiKey : e.OPENWEBUI_API_KEY) || "").trim();
    const endpoint = endpointFromUrl(url);
    return {
      backend,
      url,
      urlError,
      apiKey,
      endpoint,
      ollamaUrl: ollamaBase(e),
      embedModel: embedModelFor(backend, e),
      defaultModel: String(e.OLLAMA_MODEL || "llama3.2").trim() || "llama3.2",
      chatMs: positiveMs(e.OLLAMA_MS, 90000),
      tagsMs: positiveMs(e.OLLAMA_TAGS_MS, 3000),
    };
  }

  function downMessage() {
    const cfg = readConfig();
    return downMessageFor(cfg.backend, cfg.endpoint);
  }

  function publicConfig() {
    const cfg = readConfig();
    const ollamaEndpoint = endpointFromUrl(cfg.ollamaUrl);
    return {
      backend: cfg.backend,
      url: cfg.url,
      hasKey: !!cfg.apiKey,
      endpoint: cfg.backend === "openwebui" ? (cfg.endpoint || "") : ollamaEndpoint,
      embedModel: cfg.embedModel,
      defaultModel: cfg.defaultModel,
      downLabel: downMessageFor(cfg.backend, cfg.endpoint),
    };
  }

  function saveConfig(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, error: "JSON 唔啱" };
    }
    const backend = payload.backend === "openwebui" ? "openwebui" : (payload.backend === "ollama" ? "ollama" : "");
    if (!backend) return { ok: false, error: "要揀後端" };
    const prev = readConfig();
    let url = prev.url;
    if (Object.prototype.hasOwnProperty.call(payload, "url")) {
      const raw = String(payload.url || "").trim();
      if (!raw) url = "";
      else {
        const n = normalizeOpenWebUIUrl(raw);
        if (!n.ok) return { ok: false, error: stripSecret(n.error, payload.apiKey || prev.apiKey) };
        url = n.url;
      }
    }
    if (backend === "openwebui" && !url) return { ok: false, error: OWUI_URL_REQUIRED };
    let apiKey = prev.apiKey;
    if (payload.clearKey) apiKey = "";
    else if (typeof payload.apiKey === "string" && payload.apiKey.trim()) apiKey = payload.apiKey.trim();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ backend, url, apiKey }, null, 2), { mode: 0o600 });
    return { ok: true };
  }

  async function requestJson(url, options, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchFn(url, { ...options, signal: ctrl.signal });
      let data = {};
      try {
        data = await r.json();
      } catch {
        data = {};
      }
      return { ok: !!r.ok, status: r.status, data };
    } catch (err) {
      return { ok: false, status: 0, err };
    } finally {
      clearTimeout(timer);
    }
  }

  async function listChatModels() {
    const cfg = readConfig();
    if (cfg.backend === "openwebui") {
      if (!cfg.url) return { ok: false, models: [], error: cfg.urlError || OWUI_URL_REQUIRED };
      const res = await requestJson(cfg.url + "/api/models", {
        method: "GET",
        headers: authHeaders(cfg.apiKey),
      }, cfg.tagsMs);
      if (res.err) return { ok: false, models: [], error: transportError(res.err, downMessageFor(cfg.backend, cfg.endpoint), cfg.apiKey) };
      if (!res.ok) return { ok: false, models: [], error: httpStatusError(res.status, "openwebui", cfg.apiKey) };
      return { ok: true, models: modelNamesFromPayload(res.data) };
    }
    const res = await requestJson(cfg.ollamaUrl + "/api/tags", { method: "GET" }, cfg.tagsMs);
    if (res.err || !res.ok) return { ok: false, models: [], error: OLLAMA_DOWN };
    return { ok: true, models: modelNamesFromPayload(res.data) };
  }

  async function probeEmbed() {
    const cfg = readConfig();
    const listed = await listChatModels();
    if (!listed.ok) {
      return {
        ok: false,
        models: [],
        embedder: false,
        model: cfg.embedModel,
        backend: cfg.backend,
        error: listed.error || downMessageFor(cfg.backend, cfg.endpoint),
      };
    }
    let names = listed.models.slice();
    if (cfg.backend === "openwebui" && cfg.url) {
      const tags = await requestJson(cfg.url + "/ollama/api/tags", {
        method: "GET",
        headers: authHeaders(cfg.apiKey),
      }, cfg.tagsMs);
      if (tags.ok) names = names.concat(modelNamesFromPayload(tags.data));
    }
    return {
      ok: true,
      models: listed.models,
      embedder: names.some((n) => isEmbedModelName(n, cfg.embedModel)),
      model: cfg.embedModel,
      backend: cfg.backend,
    };
  }

  async function chatComplete({ model, messages, numPredict }) {
    const cfg = readConfig();
    const n = Number(numPredict) > 0 ? Number(numPredict) : 256;
    if (cfg.backend === "openwebui") {
      if (!cfg.url) return { ok: false, error: cfg.urlError || OWUI_URL_REQUIRED };
      const res = await requestJson(cfg.url + "/api/chat/completions", {
        method: "POST",
        headers: authHeaders(cfg.apiKey),
        body: JSON.stringify(openWebUIChatBody({ model, messages, maxTokens: n })),
      }, cfg.chatMs);
      if (res.err) return { ok: false, error: transportError(res.err, downMessageFor(cfg.backend, cfg.endpoint), cfg.apiKey) };
      if (!res.ok) return { ok: false, error: httpStatusError(res.status, "openwebui", cfg.apiKey) };
      return { ok: true, content: parseChatContent(res.data) };
    }
    const res = await requestJson(cfg.ollamaUrl + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ollamaChatBody({ model, messages, numPredict: n })),
    }, cfg.chatMs);
    if (res.err) return { ok: false, error: transportError(res.err, OLLAMA_DOWN, cfg.apiKey) };
    if (!res.ok) return { ok: false, error: httpStatusError(res.status, "ollama", cfg.apiKey) };
    return { ok: true, content: parseChatContent(res.data) };
  }

  async function embedText(text) {
    const cfg = readConfig();
    const status = await probeEmbed();
    if (!status.ok) return { ok: false, down: true, error: status.error || downMessageFor(cfg.backend, cfg.endpoint) };
    if (!status.embedder) return { ok: false, missing: true };
    const prompt = String(text || "").slice(0, 4000);
    if (!prompt.trim()) return { ok: false };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      if (cfg.backend !== "openwebui") {
        let r = await fetchFn(cfg.ollamaUrl + "/api/embed", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({ model: cfg.embedModel, input: prompt }),
        });
        let data = await r.json().catch(() => ({}));
        let vec = Array.isArray(data.embeddings) ? data.embeddings[0] : data.embedding;
        if (!Array.isArray(vec) || !vec.length) {
          r = await fetchFn(cfg.ollamaUrl + "/api/embeddings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: ctrl.signal,
            body: JSON.stringify({ model: cfg.embedModel, prompt }),
          });
          data = await r.json().catch(() => ({}));
          vec = data.embedding;
        }
        if (!Array.isArray(vec) || !vec.length) return { ok: false };
        return { ok: true, embedding: vec };
      }
      for (const call of embeddingCalls(cfg.embedModel, prompt)) {
        const r = await fetchFn(cfg.url + call.path, {
          method: "POST",
          headers: authHeaders(cfg.apiKey),
          signal: ctrl.signal,
          body: JSON.stringify(call.body),
        });
        if (r.status === 401 || r.status === 403) return { ok: false, error: OWUI_KEY };
        let data = {};
        try {
          data = await r.json();
        } catch {
          data = {};
        }
        if (!r.ok) continue;
        const vec = vectorFromEmbeddingPayload(data);
        if (vec) return { ok: true, embedding: vec };
      }
      return { ok: false };
    } catch {
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    readConfig,
    publicConfig,
    saveConfig,
    listChatModels,
    probeEmbed,
    chatComplete,
    embedText,
    downMessage,
    embedModel() {
      return readConfig().embedModel;
    },
  };
}
