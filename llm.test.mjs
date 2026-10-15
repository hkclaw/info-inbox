import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  authHeaders,
  contentText,
  createLlm,
  downMessageFor,
  embeddingCalls,
  endpointFromUrl,
  httpStatusError,
  isEmbedModelName,
  modelNamesFromPayload,
  normalizeOpenWebUIUrl,
  ollamaChatBody,
  openWebUIChatBody,
  parseChatContent,
  stripSecret,
  transportError,
  vectorFromEmbeddingPayload,
} from "./llm.mjs";

const SECRET = "sk-test-openwebui-key";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inbox-llm-"));
}

test("url accepts http(s) and rejects other schemes, secrets, and a trailing slash", () => {
  assert.deepEqual(normalizeOpenWebUIUrl("http://127.0.0.1:8080/"), { ok: true, url: "http://127.0.0.1:8080" });
  assert.equal(normalizeOpenWebUIUrl("https://owui.example/base/").url, "https://owui.example/base");
  assert.equal(normalizeOpenWebUIUrl("").error, "要有 Open WebUI 網址");
  for (const bad of ["file:///tmp/x", "javascript:alert(1)", "http://user:pass@127.0.0.1:8080", "http://127.0.0.1:8080/?k=" + SECRET, "not a url"]) {
    const out = normalizeOpenWebUIUrl(bad);
    assert.equal(out.ok, false);
    assert.equal(out.error, bad.trim() ? "Open WebUI 網址唔啱" : "要有 Open WebUI 網址");
    assert.equal(JSON.stringify(out).includes(SECRET), false);
  }
  assert.equal(endpointFromUrl("http://127.0.0.1:8080/base"), "127.0.0.1:8080");
});

test("auth header is bearer only when a key is present", () => {
  assert.deepEqual(authHeaders(""), { "content-type": "application/json" });
  assert.equal(authHeaders("  " + SECRET + " ").authorization, "Bearer " + SECRET);
  assert.equal(Object.hasOwn(authHeaders(""), "authorization"), false);
});

test("errors never include the api key", () => {
  const err = new Error("fetch failed while sending " + SECRET);
  err.code = "ECONNREFUSED";
  const down = transportError(err, "連唔到 Open WebUI（127.0.0.1:8080）", SECRET);
  assert.equal(down, "連唔到 Open WebUI（127.0.0.1:8080）");
  assert.equal(down.includes(SECRET), false);
  const aborted = transportError({ name: "AbortError", message: SECRET }, "連唔到 Open WebUI（127.0.0.1:8080）", SECRET);
  assert.equal(aborted, "模型回逾時");
  assert.equal(aborted.includes(SECRET), false);
  assert.equal(httpStatusError(401, "openwebui", SECRET), "Open WebUI 要 API key");
  assert.equal(httpStatusError(403, "openwebui", SECRET), "Open WebUI 要 API key");
  assert.equal(httpStatusError(500, "openwebui", SECRET), "模型回錯誤（HTTP 500）");
  assert.equal(httpStatusError(401, "ollama", SECRET), "模型回錯誤（HTTP 401）");
  assert.equal(stripSecret("prefix " + SECRET + " suffix", SECRET).includes(SECRET), false);
  assert.equal(downMessageFor("ollama", "10.0.0.8:11434"), "連唔到 Ollama（127.0.0.1:11434）");
  assert.equal(downMessageFor("openwebui", "127.0.0.1:8080"), "連唔到 Open WebUI（127.0.0.1:8080）");
});

test("parsers read Open WebUI models, chat text, and embedding vectors", () => {
  assert.deepEqual(modelNamesFromPayload({
    data: [{ id: "llama3.2", name: "display" }, { name: "only-name" }, "plain"],
  }), ["llama3.2", "only-name", "plain"]);
  assert.deepEqual(modelNamesFromPayload({ models: [{ name: "llama3.2:latest" }] }), ["llama3.2:latest"]);
  assert.equal(parseChatContent({ choices: [{ message: { content: "{\"tags\":[]}" } }] }), "{\"tags\":[]}");
  assert.equal(parseChatContent({
    choices: [{ message: { content: [{ type: "text", text: "{\"a\":1}" }] } }],
  }), "{\"a\":1}");
  assert.equal(contentText([{ text: "ab" }, { content: "c" }]), "abc");
  assert.equal(parseChatContent({ message: { content: "ollama" } }), "ollama");
  assert.deepEqual(vectorFromEmbeddingPayload({ data: [{ embedding: [1, 2] }] }), [1, 2]);
  assert.deepEqual(vectorFromEmbeddingPayload({ embeddings: [[3, 4]] }), [3, 4]);
  assert.deepEqual(vectorFromEmbeddingPayload({ embedding: [5, 6] }), [5, 6]);
  assert.equal(isEmbedModelName("nomic-embed-text:latest", "nomic-embed-text"), true);
  assert.equal(isEmbedModelName("llama3.2", "nomic-embed-text"), false);
});

test("chat bodies keep Ollama json options and Open WebUI response_format", () => {
  const messages = [{ role: "user", content: "hi" }];
  assert.deepEqual(ollamaChatBody({ model: "llama3.2", messages, numPredict: 256 }), {
    model: "llama3.2",
    stream: false,
    format: "json",
    messages,
    options: { num_predict: 256 },
  });
  assert.deepEqual(openWebUIChatBody({ model: "llama3.2", messages, maxTokens: 256 }), {
    model: "llama3.2",
    messages,
    stream: false,
    max_tokens: 256,
    response_format: { type: "json_object" },
  });
  assert.deepEqual(embeddingCalls("nomic-embed-text", "hello").map((c) => c.path), [
    "/api/embeddings",
    "/ollama/api/embed",
    "/ollama/v1/embeddings",
    "/ollama/api/embeddings",
  ]);
});

test("saved llm.json wins over env and never returns the key", () => {
  const dir = tmpDir();
  const env = {
    LLM_BACKEND: "ollama",
    OPENWEBUI_URL: "http://127.0.0.1:3000",
    OPENWEBUI_API_KEY: "env-secret-key-value",
    OLLAMA_EMBED: "nomic-embed-text",
  };
  const llm = createLlm({ dataDir: dir, env, fetchImpl: async () => { throw new Error("no fetch"); } });
  assert.equal(llm.publicConfig().backend, "ollama");
  assert.equal(llm.publicConfig().downLabel, "連唔到 Ollama（127.0.0.1:11434）");
  const saved = llm.saveConfig({ backend: "openwebui", url: "http://127.0.0.1:8080/", apiKey: SECRET });
  assert.equal(saved.ok, true);
  env.LLM_BACKEND = "ollama";
  const pub = llm.publicConfig();
  assert.equal(pub.backend, "openwebui");
  assert.equal(pub.url, "http://127.0.0.1:8080");
  assert.equal(pub.hasKey, true);
  assert.equal(pub.endpoint, "127.0.0.1:8080");
  assert.equal(JSON.stringify(pub).includes(SECRET), false);
  assert.equal(Object.hasOwn(pub, "apiKey"), false);
  const kept = llm.saveConfig({ backend: "openwebui", url: "http://127.0.0.1:9090" });
  assert.equal(kept.ok, true);
  assert.equal(llm.readConfig().apiKey, SECRET);
  assert.equal(JSON.stringify(llm.publicConfig()).includes(SECRET), false);
  llm.saveConfig({ backend: "openwebui", url: "http://127.0.0.1:9090", clearKey: true });
  assert.equal(llm.readConfig().apiKey, "");
  assert.equal(llm.publicConfig().hasKey, false);
  const bad = llm.saveConfig({ backend: "openwebui", url: "http://127.0.0.1/?k=" + SECRET, apiKey: SECRET });
  assert.equal(bad.ok, false);
  assert.equal(JSON.stringify(bad).includes(SECRET), false);
  const file = JSON.parse(fs.readFileSync(path.join(dir, "llm.json"), "utf8"));
  assert.equal(file.apiKey, "");
});

test("Open WebUI chat, model list, and embedding fallback", async () => {
  const dir = tmpDir();
  const calls = [];
  const llm = createLlm({
    dataDir: dir,
    env: {
      LLM_BACKEND: "openwebui",
      OPENWEBUI_URL: "http://127.0.0.1:8080",
      OPENWEBUI_API_KEY: SECRET,
    },
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      const auth = opts.headers && opts.headers.authorization;
      assert.equal(auth, "Bearer " + SECRET);
      if (url.endsWith("/api/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "llama3.2" }, { id: "nomic-embed-text" }] }) };
      }
      if (url.endsWith("/api/chat/completions")) {
        const body = JSON.parse(opts.body);
        assert.equal(body.stream, false);
        assert.equal(body.max_tokens, 256);
        assert.deepEqual(body.response_format, { type: "json_object" });
        assert.equal(body.format, undefined);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: [{ type: "text", text: "{\"ok\":true}" }] } }] }) };
      }
      if (url.endsWith("/api/embeddings")) return { ok: false, status: 404, json: async () => ({}) };
      if (url.endsWith("/ollama/api/embed")) {
        return { ok: true, status: 200, json: async () => ({ embeddings: [[0.25, 0.5]] }) };
      }
      if (url.endsWith("/ollama/api/tags")) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: false, status: 500, json: async () => ({ error: SECRET }) };
    },
  });
  const listed = await llm.listChatModels();
  assert.deepEqual(listed.models, ["llama3.2", "nomic-embed-text"]);
  const chat = await llm.chatComplete({ model: "llama3.2", messages: [{ role: "user", content: "hi" }], numPredict: 256 });
  assert.equal(chat.ok, true);
  assert.equal(chat.content, "{\"ok\":true}");
  const emb = await llm.embedText("hello note");
  assert.equal(emb.ok, true);
  assert.deepEqual(emb.embedding, [0.25, 0.5]);
  assert.equal(calls.some((c) => c.url.endsWith("/ollama/v1/embeddings")), false);
  assert.equal(JSON.stringify({ listed, chat, emb }).includes(SECRET), false);
});

test("Open WebUI 401 stops before later embedding routes", async () => {
  const dir = tmpDir();
  const urls = [];
  const llm = createLlm({
    dataDir: dir,
    env: { LLM_BACKEND: "openwebui", OPENWEBUI_URL: "http://127.0.0.1:8080", OPENWEBUI_API_KEY: SECRET },
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith("/api/models")) {
        return { ok: false, status: 401, json: async () => ({ detail: SECRET }) };
      }
      return { ok: false, status: 401, json: async () => ({}) };
    },
  });
  const listed = await llm.listChatModels();
  assert.equal(listed.ok, false);
  assert.equal(listed.error, "Open WebUI 要 API key");
  assert.equal(JSON.stringify(listed).includes(SECRET), false);
  const emb = await llm.embedText("hello");
  assert.equal(emb.down, true);
  assert.equal(urls.some((u) => u.includes("/api/embeddings")), false);
});

test("Ollama chat stays on the native API", async () => {
  const dir = tmpDir();
  let body;
  const llm = createLlm({
    dataDir: dir,
    env: {},
    fetchImpl: async (url, opts) => {
      assert.equal(String(url).startsWith("http://127.0.0.1:11434"), true);
      assert.equal(opts.headers && opts.headers.authorization, undefined);
      if (String(url).endsWith("/api/tags")) {
        return { ok: true, status: 200, json: async () => ({ models: [{ name: "llama3.2:latest" }, { name: "nomic-embed-text" }] }) };
      }
      body = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ message: { content: "{\"tags\":[\"a\"]}" } }) };
    },
  });
  assert.equal(llm.publicConfig().backend, "ollama");
  const chat = await llm.chatComplete({
    model: "llama3.2:latest",
    messages: [{ role: "user", content: "hi" }],
    numPredict: 256,
  });
  assert.equal(chat.content, "{\"tags\":[\"a\"]}");
  assert.equal(body.format, "json");
  assert.equal(body.options.num_predict, 256);
  assert.equal(body.response_format, undefined);
  const probe = await llm.probeEmbed();
  assert.equal(probe.embedder, true);
});
