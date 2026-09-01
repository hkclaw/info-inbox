import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const BIND = process.env.BIND || "127.0.0.1";
const PORT = Number(process.env.PORT || 3741);
const dataDir = path.join(root, "data");
const storeFile = path.join(dataDir, "inbox.json");
const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const OLLAMA_MS = Number(process.env.OLLAMA_MS || 20000);
const CLASSIFY_FAIL = "連唔到 Ollama（127.0.0.1:11434）";

function emptyStore() {
  return { notes: [], questions: [] };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(storeFile, "utf8"));
  } catch {
    return emptyStore();
  }
}

function save(store) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2));
}

function json(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(data);
  });
}


async function classify(text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OLLAMA_MS);
  try {
    const r = await fetch(OLLAMA + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        format: "json",
        messages: [
          {
            role: "system",
            content:
              'Classify a personal note. JSON only: {"tags":["project-or-topic"],"summary":"one sentence","question":null}. Two to five short tags. If the dump is too vague to file, tags may be empty and question must be a short clarifying ask. Do not invent facts that are not in the text.',
          },
          { role: "user", content: String(text).slice(0, 8000) },
        ],
      }),
    });
    if (!r.ok) return { ok: false };
    const data = await r.json();
    const raw = data && data.message && data.message.content;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = String(raw || "").match(/\{[\s\S]*\}/);
      if (!m) return { ok: false };
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        return { ok: false };
      }
    }
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
      : [];
    const summary = parsed.summary ? String(parsed.summary).trim() : "";
    const question = parsed.question ? String(parsed.question).trim() : "";
    if (!tags.length && !summary && !question) return { ok: false };
    return { ok: true, tags, summary: summary || null, question: question || null };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function searchHay(q, store) {
  const needle = q.trim().toLowerCase();
  if (!needle) return { notes: [], questions: [] };
  const notes = store.notes.filter((n) => {
    const blob = [n.text, n.summary, ...(n.tags || [])].filter(Boolean).join(" ").toLowerCase();
    return blob.includes(needle);
  });
  const questions = store.questions.filter((item) => {
    const blob = [item.text, item.answer, item.status].filter(Boolean).join(" ").toLowerCase();
    return blob.includes(needle);
  });
  return { notes, questions };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const method = req.method || "GET";

  if (method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
    sendFile(res, path.join(root, "index.html"));
    return;
  }

  if (method === "GET" && u.pathname === "/api/notes") {
    json(res, 200, { notes: load().notes });
    return;
  }

  if (method === "GET" && u.pathname === "/api/questions") {
    json(res, 200, { questions: load().questions });
    return;
  }

  if (method === "GET" && u.pathname === "/api/search") {
    json(res, 200, searchHay(u.searchParams.get("q") || "", load()));
    return;
  }

  if (method === "POST" && u.pathname === "/api/ingest") {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      json(res, 400, { error: "JSON 唔啱" });
      return;
    }
    const text = String(payload.text || "").trim();
    if (!text) {
      json(res, 400, { error: "要有文字先 dump" });
      return;
    }
    const store = load();
    const note = {
      id: String(Date.now()),
      text,
      createdAt: new Date().toISOString(),
      tags: [],
      summary: null,
      classifyError: CLASSIFY_FAIL,
    };
    store.notes.unshift(note);
    save(store);
    const result = await classify(text);
    const next = load();
    const row = next.notes.find((n) => n.id === note.id) || note;
    let queued = null;
    if (result.ok) {
      row.tags = result.tags;
      row.summary = result.summary;
      row.classifyError = null;
      if (result.question) {
        queued = {
          id: String(Date.now() + 1),
          text: result.question,
          status: "open",
          answer: null,
          noteId: row.id,
          createdAt: new Date().toISOString(),
        };
        next.questions.unshift(queued);
      }
    } else {
      row.tags = [];
      row.summary = null;
      row.classifyError = CLASSIFY_FAIL;
    }
    save(next);
    json(res, 200, { ok: true, note: row, classified: !!result.ok, question: queued });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.listen(PORT, BIND, () => {
  console.log("info-inbox http://" + BIND + ":" + PORT + "/");
});
