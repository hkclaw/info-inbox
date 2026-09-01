import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const BIND = process.env.BIND || "127.0.0.1";
const PORT = Number(process.env.PORT || 3741);
const dataDir = path.join(root, "data");
const storeFile = path.join(dataDir, "inbox.json");

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
      classifyError: "未分類（模型未接）",
    };
    store.notes.unshift(note);
    save(store);
    json(res, 200, { ok: true, note, classified: false });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.listen(PORT, BIND, () => {
  console.log("info-inbox http://" + BIND + ":" + PORT + "/");
});
