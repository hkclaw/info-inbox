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
  return { notes: [], questions: [], dismissedMerges: [] };
}

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    if (!Array.isArray(s.notes)) s.notes = [];
    if (!Array.isArray(s.questions)) s.questions = [];
    if (!Array.isArray(s.dismissedMerges)) s.dismissedMerges = [];
    return s;
  } catch {
    return emptyStore();
  }
}

function pairKey(a, b) {
  return [String(a), String(b)].sort().join("|");
}

function tokens(s) {
  const t = String(s || "").toLowerCase();
  const out = new Set();
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  const cjk = t.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjk) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function suggestMerges(store) {
  const dismissed = new Set(store.dismissedMerges);
  const notes = store.notes;
  const bag = notes.map((n) => tokens((n.text || "") + " " + (n.summary || "")));
  const pairs = [];
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const a = notes[i];
      const b = notes[j];
      const key = pairKey(a.id, b.id);
      if (dismissed.has(key)) continue;
      const ta = new Set((a.tags || []).map((x) => String(x).toLowerCase()));
      const tb = new Set((b.tags || []).map((x) => String(x).toLowerCase()));
      const shared = [...ta].filter((x) => tb.has(x));
      const jac = jaccard(bag[i], bag[j]);
      let inter = 0;
      for (const x of bag[i]) if (bag[j].has(x)) inter++;
      let reason = "";
      if (shared.length) reason = "相同 tag：" + shared.slice(0, 4).join("、");
      else if (jac >= 0.22 || inter >= 4) reason = "文字重疊";
      if (!reason) continue;
      pairs.push({ a: a.id, b: b.id, reason });
    }
  }
  return pairs;
}

async function maybeRewriteSummary(text) {
  const result = await classify(text);
  if (result.ok && result.summary) return result.summary;
  return null;
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

  const delNote = /^\/api\/notes\/([^/]+)$/.exec(u.pathname);
  if (method === "DELETE" && delNote) {
    const id = decodeURIComponent(delNote[1]);
    const store = load();
    const i = store.notes.findIndex((n) => n.id === id);
    if (i < 0) {
      json(res, 404, { error: "搵唔到呢條筆記" });
      return;
    }
    store.notes.splice(i, 1);
    save(store);
    json(res, 200, { ok: true, deleted: id });
    return;
  }

  const reclass = /^\/api\/notes\/([^/]+)\/reclassify$/.exec(u.pathname);
  if (method === "POST" && reclass) {
    const id = decodeURIComponent(reclass[1]);
    const store = load();
    const row = store.notes.find((n) => n.id === id);
    if (!row) {
      json(res, 404, { error: "搵唔到呢條筆記" });
      return;
    }
    const result = await classify(row.text || "");
    if (result.ok) {
      row.tags = result.tags;
      row.summary = result.summary;
      row.classifyError = null;
    } else {
      row.classifyError = CLASSIFY_FAIL;
    }
    save(store);
    json(res, 200, { ok: true, note: row, classified: !!result.ok });
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

  const ansPath = /^\/api\/questions\/([^/]+)\/answer$/.exec(u.pathname);
  if (method === "POST" && ansPath) {
    const id = decodeURIComponent(ansPath[1]);
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      json(res, 400, { error: "JSON 唔啱" });
      return;
    }
    const answer = String(payload.answer || "").trim();
    if (!answer) {
      json(res, 400, { error: "要有答案" });
      return;
    }
    const store = load();
    const row = store.questions.find((q) => q.id === id);
    if (!row) {
      json(res, 404, { error: "搵唔到呢條問題" });
      return;
    }
    if (row.status === "answered") {
      json(res, 409, { error: "呢條已答過" });
      return;
    }
    if (!row.noteId) {
      json(res, 400, { error: "呢條冇來源筆記" });
      return;
    }
    const src = store.notes.find((n) => n.id === row.noteId);
    if (!src) {
      json(res, 404, { error: "搵唔到來源筆記" });
      return;
    }
    const line = "（澄清）答：" + answer;
    src.text = (src.text || "").trim() + "\n\n" + line;
    if (!Array.isArray(src.clarifications)) src.clarifications = [];
    src.clarifications.push({ questionId: row.id, answer, at: new Date().toISOString() });
    row.answer = answer;
    row.status = "answered";
    row.answeredAt = new Date().toISOString();
    save(store);
    json(res, 200, { ok: true, question: row, note: src });
    return;
  }

  if (method === "GET" && u.pathname === "/api/merge-suggestions") {
    const store = load();
    json(res, 200, { suggestions: suggestMerges(store) });
    return;
  }

  if (method === "POST" && u.pathname === "/api/merge-suggestions/dismiss") {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      json(res, 400, { error: "JSON 唔啱" });
      return;
    }
    const key = pairKey(payload.a, payload.b);
    if (!payload.a || !payload.b) {
      json(res, 400, { error: "要有一對筆記" });
      return;
    }
    const store = load();
    if (!store.dismissedMerges.includes(key)) store.dismissedMerges.push(key);
    save(store);
    json(res, 200, { ok: true, dismissed: key });
    return;
  }

  if (method === "POST" && u.pathname === "/api/merge-suggestions/accept") {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      json(res, 400, { error: "JSON 唔啱" });
      return;
    }
    const idA = String(payload.a || "");
    const idB = String(payload.b || "");
    if (!idA || !idB || idA === idB) {
      json(res, 400, { error: "要有一對筆記" });
      return;
    }
    const store = load();
    const a = store.notes.find((n) => n.id === idA);
    const b = store.notes.find((n) => n.id === idB);
    if (!a || !b) {
      json(res, 404, { error: "搵唔到呢對筆記" });
      return;
    }
    const keep = (a.createdAt || "") <= (b.createdAt || "") ? a : b;
    const drop = keep === a ? b : a;
    const tags = [];
    for (const x of [...(keep.tags || []), ...(drop.tags || [])]) {
      const s = String(x).trim();
      if (s && !tags.includes(s)) tags.push(s);
    }
    const text = (keep.text || "").trim() + "\n\n" + (drop.text || "").trim();
    keep.text = text;
    keep.tags = tags;
    const rewritten = await maybeRewriteSummary(text);
    if (rewritten) keep.summary = rewritten;
    else if (!keep.summary && drop.summary) keep.summary = drop.summary;
    const dropKey = drop.id;
    store.notes = store.notes.filter((n) => n.id !== dropKey);
    store.dismissedMerges = store.dismissedMerges.filter((k) => !k.split("|").includes(dropKey) && !k.split("|").includes(keep.id));
    save(store);
    json(res, 200, { ok: true, note: keep, deleted: dropKey });
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
