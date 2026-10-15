import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const SECRET = "sk-test-openwebui-key";
const root = path.dirname(new URL(import.meta.url).pathname);

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function readReq(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function onceLine(stream, needle) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk;
      if (buf.includes(needle)) {
        stream.off("data", onData);
        resolve(buf);
      }
    };
    stream.on("data", onData);
    stream.on("error", reject);
  });
}

async function jsonFetch(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: r.status, data, text };
}

test("inbox uses the Open WebUI API and can fall back to Ollama copy", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-owui-"));
  let modelRows = [{ id: "llama3.2" }, { id: "nomic-embed-text" }];
  const seen = [];
  let chatBody = null;
  const stub = http.createServer(async (req, res) => {
    const auth = req.headers.authorization || "";
    const body = req.method === "POST" ? await readReq(req) : "";
    seen.push(req.method + " " + req.url);
    if (auth !== "Bearer " + SECRET) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: modelRows }));
      return;
    }
    if (req.method === "GET" && req.url === "/ollama/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "nomic-embed-text" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/chat/completions") {
      chatBody = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ tags: ["inbox"], summary: "one line", question: null }) } }],
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/embeddings") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method === "POST" && req.url === "/ollama/api/embed") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("missing");
  });
  const stubPort = await listen(stub);
  const appPort = await freePort();
  const app = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(appPort),
      BIND: "127.0.0.1",
      INFO_INBOX_DATA: tmp,
      LLM_BACKEND: "openwebui",
      OPENWEBUI_URL: "http://127.0.0.1:" + stubPort,
      OPENWEBUI_API_KEY: SECRET,
      OLLAMA_URL: "http://127.0.0.1:9",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  app.stdout.on("data", (c) => { logs += c; });
  app.stderr.on("data", (c) => { logs += c; });
  t.after(() => {
    app.kill("SIGTERM");
    stub.close();
  });
  await onceLine(app.stdout, "info-inbox");
  const base = "http://127.0.0.1:" + appPort;

  const models = await jsonFetch(base + "/api/models");
  assert.equal(models.data.ok, true);
  assert.equal(models.data.backend, "openwebui");
  assert.equal(models.data.selected, "llama3.2");
  assert.deepEqual(models.data.models, ["llama3.2", "nomic-embed-text"]);
  assert.equal(models.data.hasKey, true);
  assert.equal(models.text.includes(SECRET), false);
  assert.equal(Object.hasOwn(models.data, "apiKey"), false);

  const llm = await jsonFetch(base + "/api/llm");
  assert.equal(llm.data.backend, "openwebui");
  assert.equal(llm.data.hasKey, true);
  assert.equal(llm.data.endpoint, "127.0.0.1:" + stubPort);
  assert.equal(llm.text.includes(SECRET), false);

  modelRows = [{ id: "nomic-embed-text" }];
  const onlyEmbed = await jsonFetch(base + "/api/models");
  assert.equal(onlyEmbed.data.ok, true);
  assert.equal(onlyEmbed.data.selected, null);
  modelRows = [{ id: "llama3.2" }, { id: "nomic-embed-text" }];

  const ingested = await jsonFetch(base + "/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "buy milk tomorrow at the market" }),
  });
  assert.equal(ingested.data.classified, true, logs + "\n" + ingested.text);
  assert.deepEqual(ingested.data.note.tags, ["inbox"]);
  assert.equal(ingested.data.note.summary, "one line");
  assert.equal(ingested.text.includes(SECRET), false);
  assert.equal(chatBody.model, "llama3.2");
  assert.equal(chatBody.stream, false);
  assert.equal(chatBody.max_tokens, 256);
  assert.deepEqual(chatBody.response_format, { type: "json_object" });
  assert.equal(chatBody.format, undefined);
  assert.equal(seen.includes("POST /api/embeddings"), true);
  assert.equal(seen.includes("POST /ollama/api/embed"), true);

  const embed = await jsonFetch(base + "/api/embed-status");
  assert.equal(embed.data.ok, true);
  assert.equal(embed.data.embedder, true);
  assert.equal(embed.data.backend, "openwebui");
  assert.equal(embed.data.model, "nomic-embed-text");
  const vectors = JSON.parse(fs.readFileSync(path.join(tmp, "vectors.json"), "utf8"));
  assert.deepEqual(vectors[ingested.data.note.id], [0.1, 0.2, 0.3]);

  const bad = await jsonFetch(base + "/api/llm", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ backend: "openwebui", url: "http://127.0.0.1:8080/?k=" + SECRET }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.text.includes(SECRET), false);

  const ollama = await jsonFetch(base + "/api/llm", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ backend: "ollama" }),
  });
  assert.equal(ollama.data.backend, "ollama");
  assert.equal(ollama.data.downLabel, "連唔到 Ollama（127.0.0.1:11434）");
  assert.equal(ollama.text.includes(SECRET), false);
  const down = await jsonFetch(base + "/api/models");
  assert.equal(down.data.ok, false);
  assert.equal(down.data.backend, "ollama");
  assert.equal(down.data.error, "連唔到 Ollama（127.0.0.1:11434）");
  assert.equal(down.data.downLabel, "連唔到 Ollama（127.0.0.1:11434）");
});
