import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import zlib from "node:zlib";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WordExtractor = require("word-extractor");

const root = path.dirname(fileURLToPath(import.meta.url));
const BIND = process.env.BIND || "127.0.0.1";
const PORT = Number(process.env.PORT || 3741);
const dataDir = path.join(root, "data");
const storeFile = path.join(dataDir, "inbox.json");
const modelFile = path.join(dataDir, "ollama-model.json");
const boxFile = path.join(dataDir, "current-box.json");
const vectorFile = path.join(dataDir, "vectors.json");
const EMBED_MODEL = process.env.OLLAMA_EMBED || "nomic-embed-text";
const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const OLLAMA_MS = Number(process.env.OLLAMA_MS || 90000);
const CLASSIFY_CHARS = 4000;
const CLASSIFY_NUM_PREDICT = 256;
const TAGS_MS = Number(process.env.OLLAMA_TAGS_MS || 3000);
const CLASSIFY_FAIL = "連唔到 Ollama（127.0.0.1:11434）";
const CLASSIFY_NO_TEXT = "未有合適文字模型";
const CLASSIFY_TIMEOUT = "模型回逾時";
function classifyHttpError(status) {
  return "模型回錯誤（HTTP " + status + "）";
}
function classifyCatchError(err) {
  if (err && err.name === "AbortError") return CLASSIFY_TIMEOUT;
  const code = err && (err.code || (err.cause && err.cause.code));
  const msg = String((err && err.message) || "");
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || /fetch failed|ECONNREFUSED/i.test(msg)) {
    return CLASSIFY_FAIL;
  }
  return "模型回錯誤";
}
const TEXT_EXTS = new Set([".txt", ".md", ".csv", ".json", ".html", ".log"]);
const UNSUPPORTED_BODY = "未支援抽文字";

function loadModelPreference() {
  try {
    const s = JSON.parse(fs.readFileSync(modelFile, "utf8"));
    const model = s && s.model != null ? String(s.model).trim() : "";
    return model || null;
  } catch {
    return null;
  }
}

function saveModelPreference(model) {
  const name = String(model || "").trim();
  if (!name) return;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(modelFile, JSON.stringify({ model: name }, null, 2));
}

function normalizeBox(s) {
  return String(s || "").trim().replace(/\s+/g, " ").slice(0, 40);
}

function loadCurrentBox() {
  try {
    const s = JSON.parse(fs.readFileSync(boxFile, "utf8"));
    return normalizeBox(s && s.box);
  } catch {
    return "";
  }
}

function saveCurrentBox(box) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(boxFile, JSON.stringify({ box: normalizeBox(box) }, null, 2));
}

function listBoxes(store) {
  const out = [];
  for (const n of (store && store.notes) || []) {
    const b = normalizeBox(n.box);
    if (b && !out.includes(b)) out.push(b);
  }
  return out;
}


function isDefaultModelName(name) {
  const n = String(name || "");
  return n === "llama3.2" || n.startsWith("llama3.2:");
}

function isBlockedAutoModel(name) {
  const n = String(name || "").toLowerCase();
  return /vl|vision/.test(n) || /27b|32b/.test(n);
}

function pickDefaultModel(models) {
  const list = Array.isArray(models) ? models : [];
  const llama = list.find(isDefaultModelName);
  if (llama) return llama;
  const pref = loadModelPreference();
  if (pref && list.includes(pref) && !isBlockedAutoModel(pref)) return pref;
  return list.find((m) => !isBlockedAutoModel(m)) || null;
}

async function listOllamaModels() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TAGS_MS);
  try {
    const r = await fetch(OLLAMA + "/api/tags", { signal: ctrl.signal });
    if (!r.ok) return { ok: false, models: [] };
    const data = await r.json();
    const models = Array.isArray(data && data.models)
      ? data.models
          .map((m) => (m && m.name != null ? String(m.name).trim() : ""))
          .filter(Boolean)
      : [];
    return { ok: true, models };
  } catch {
    return { ok: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

function getActiveModel() {
  const pref = loadModelPreference();
  if (pref && !isBlockedAutoModel(pref)) return pref;
  return DEFAULT_MODEL;
}

function emptyStore() {
  return { notes: [], questions: [], dismissedMerges: [] };
}

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    if (!Array.isArray(s.notes)) s.notes = [];
    if (!Array.isArray(s.questions)) s.questions = [];
    if (!Array.isArray(s.dismissedMerges)) s.dismissedMerges = [];
    for (const n of s.notes) n.box = normalizeBox(n.box);
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
      if (normalizeBox(a.box) !== normalizeBox(b.box)) continue;
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

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(buf, boundary) {
  const parts = [];
  const sep = Buffer.from("--" + boundary);
  let start = indexOf(buf, sep, 0);
  while (start >= 0) {
    let partStart = start + sep.length;
    if (buf[partStart] === 45 && buf[partStart + 1] === 45) break; // --
    if (buf[partStart] === 13 && buf[partStart + 1] === 10) partStart += 2;
    else if (buf[partStart] === 10) partStart += 1;
    const next = indexOf(buf, sep, partStart);
    if (next < 0) break;
    let partEnd = next;
    if (partEnd >= 2 && buf[partEnd - 2] === 13 && buf[partEnd - 1] === 10) partEnd -= 2;
    else if (partEnd >= 1 && buf[partEnd - 1] === 10) partEnd -= 1;
    const part = buf.subarray(partStart, partEnd);
    const headerEnd = findHeaderEnd(part);
    if (headerEnd < 0) {
      start = next;
      continue;
    }
    const headers = part.subarray(0, headerEnd).toString("utf8");
    const bodyStart = headerEnd;
    const nameMatch = /name="([^"]+)"/i.exec(headers);
    const fileMatch = /filename="([^"]*)"/i.exec(headers);
    const name = nameMatch ? nameMatch[1] : "";
    const filename = fileMatch ? path.basename(fileMatch[1].replace(/\\/g, "/")) : null;
    parts.push({ name, filename, data: part.subarray(bodyStart) });
    start = next;
  }
  return parts;
}

function indexOf(buf, needle, from) {
  return buf.indexOf(needle, from);
}

function findHeaderEnd(part) {
  for (let i = 0; i < part.length - 3; i++) {
    if (part[i] === 13 && part[i + 1] === 10 && part[i + 2] === 13 && part[i + 3] === 10) return i + 4;
  }
  for (let i = 0; i < part.length - 1; i++) {
    if (part[i] === 10 && part[i + 1] === 10) return i + 2;
  }
  return -1;
}

function basenameOnly(name) {
  return path.basename(String(name || "").replace(/\\/g, "/")) || "file";
}

function extOf(filename) {
  const base = basenameOnly(filename);
  const i = base.lastIndexOf(".");
  if (i <= 0) return "";
  return base.slice(i).toLowerCase();
}

async function extractSpreadsheet(data) {
  const wb = XLSX.read(data, { type: "buffer", cellDates: true });
  const names = wb.SheetNames || [];
  if (!names.length) return "";
  const parts = [];
  for (const name of names) {
    parts.push("# " + name);
    const sheet = wb.Sheets[name];
    parts.push(sheet ? XLSX.utils.sheet_to_csv(sheet) : "");
  }
  return parts.join("\n").trim();
}



function unzipNamed(buf, keep) {
  const out = [];
  let i = 0;
  while (i + 30 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8);
    const flags = buf.readUInt16LE(i + 6);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString("utf8");
    let start = i + 30 + nameLen + extraLen;
    let size = compSize;
    if (flags & 8) {
      /* data descriptor; skip unsupported pptx */
      break;
    }
    const comp = buf.slice(start, start + size);
    i = start + size;
    if (!keep(name)) continue;
    let raw;
    try {
      raw = method === 0 ? comp : zlib.inflateRawSync(comp);
    } catch {
      continue;
    }
    out.push({ name, text: raw.toString("utf8") });
  }
  return out;
}

function xmlSlideText(xml) {
  const parts = [];
  const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let m;
  while ((m = re.exec(xml))) {
    const s = m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
    if (s) parts.push(s);
  }
  return parts.join(" ");
}


function utf16Runs(buf, minLen) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const out = [];
  const need = minLen || 6;
  for (let i = 0; i + 1 < b.length; i += 2) {
    const chars = [];
    let j = i;
    while (j + 1 < b.length) {
      const c = b[j] | (b[j + 1] << 8);
      if (c === 0) break;
      const ok = (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd);
      if (!ok) break;
      chars.push(String.fromCharCode(c));
      j += 2;
    }
    if (chars.length >= need) {
      const s = chars.join("").trim();
      if (s && /[\u4e00-\u9fffA-Za-z0-9]/.test(s)) out.push(s);
      i = j;
    }
  }
  return out;
}

function extractPpt(data, filename) {
  try {
    const buf = Buffer.from(data);
    if (buf[0] === 0x50 && buf[1] === 0x4b) return extractPptx(buf, filename);
    let blob = buf;
    try {
      if (XLSX.CFB && typeof XLSX.CFB.read === "function") {
        const cfb = XLSX.CFB.read(buf, { type: "buffer" });
        const entry = (XLSX.CFB.find && (XLSX.CFB.find(cfb, "PowerPoint Document") || XLSX.CFB.find(cfb, "/PowerPoint Document")));
        if (entry && entry.content) blob = Buffer.from(entry.content);
      }
    } catch { /* scan whole OLE */ }
    const text = utf16Runs(blob, 6).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) {
      return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
    }
    return { text, supported: true };
  } catch {
    return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
  }
}

function extractPptx(data, filename) {
  try {
    const slides = unzipNamed(Buffer.from(data), (n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n));
    slides.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const text = slides.map((s) => xmlSlideText(s.text)).filter(Boolean).join("\n\n").trim();
    if (!text) {
      return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
    }
    return { text, supported: true };
  } catch {
    return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
  }
}


async function extractDoc(data, filename) {
  try {
    if (data[0] === 0x50 && data[1] === 0x4b) {
      return extractDocx(data, filename);
    }
    const extractor = new WordExtractor();
    const doc = await extractor.extract(Buffer.from(data));
    const text = String(doc && doc.getBody ? doc.getBody() : "").trim();
    if (!text) {
      return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
    }
    return { text, supported: true };
  } catch {
    return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
  }
}

async function extractDocx(data, filename) {
  try {
    const result = await mammoth.extractRawText({ buffer: data });
    const text = result && typeof result.value === "string" ? result.value.trim() : "";
    if (!text) {
      return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
    }
    return { text, supported: true };
  } catch {
    return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
  }
}


function extractRtf(data, filename) {
  try {
    const raw = Buffer.from(data).toString("latin1");
    if (!/\\rtf/i.test(raw.slice(0, 80))) {
      return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
    }
    const text = raw
      .replace(/\\par[d]?/g, "\n")
      .replace(/\\tab/g, "\t")
      .replace(/\\line/g, "\n")
      .replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u(-?\d+)\s?/g, (_, n) => {
        let c = Number(n);
        if (c < 0) c += 65536;
        try { return String.fromCharCode(c); } catch { return ""; }
      })
      .replace(/\\[a-zA-Z]+\-?\d* ?/g, "")
      .replace(/[{}]/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text) {
      return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
    }
    return { text, supported: true };
  } catch {
    return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
  }
}

function xmlLooseText(xml) {
  return String(xml || "")
    .replace(/<text:p\b[^>]*>/g, "\n")
    .replace(/<text:h\b[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractOdt(data, filename) {
  try {
    const files = unzipNamed(Buffer.from(data), (n) => /(^|\/)content\.xml$/i.test(n));
    const xml = files.map((f) => f.text).join("\n");
    const text = xmlLooseText(xml);
    if (!text) {
      return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
    }
    return { text, supported: true };
  } catch {
    return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
  }
}


function decodeRfc2047(s) {
  return String(s || "").replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, cs, enc, body) => {
    try {
      if (/b/i.test(enc)) return Buffer.from(body, "base64").toString("utf8");
      const raw = body.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
      return Buffer.from(raw, "latin1").toString("utf8");
    } catch {
      return body;
    }
  });
}

function decodeTransfer(body, encoding) {
  const enc = String(encoding || "").toLowerCase();
  const raw = String(body || "");
  try {
    if (enc.includes("base64")) return Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("utf8");
    if (enc.includes("quoted-printable")) {
      return raw.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
  } catch { /* keep raw */ }
  return raw;
}

function stripHtmlish(s) {
  return String(s || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function emlHeader(raw, name) {
  const re = new RegExp("^" + name + ":\\s*([\\s\\S]*?)(?=\\n\\S|\\n\\n|$)", "im");
  const m = String(raw || "").replace(/\r\n/g, "\n").match(re);
  if (!m) return "";
  return decodeRfc2047(m[1].replace(/\n[ \t]+/g, " ").trim());
}

function extractEml(data, filename) {
  try {
    const raw = Buffer.from(data).toString("latin1").replace(/\r\n/g, "\n");
    if (!raw.trim()) {
      return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
    }
    const split = raw.indexOf("\n\n");
    const head = split >= 0 ? raw.slice(0, split) : raw;
    let body = split >= 0 ? raw.slice(split + 2) : "";
    const subject = emlHeader(head, "Subject");
    const from = emlHeader(head, "From");
    const date = emlHeader(head, "Date");
    const ctype = (emlHeader(head, "Content-Type") || "").toLowerCase();
    const cte = emlHeader(head, "Content-Transfer-Encoding");
    const bm = ctype.match(/boundary="?([^";\s]+)"?/i);
    let plain = "";
    let html = "";
    if (bm) {
      const bound = "--" + bm[1];
      const parts = body.split(bound);
      for (const part of parts) {
        const ps = part.indexOf("\n\n");
        if (ps < 0) continue;
        const ph = part.slice(0, ps);
        const pb = part.slice(ps + 2).replace(/\n--\s*$/, "");
        const pct = (emlHeader(ph, "Content-Type") || "").toLowerCase();
        const pe = emlHeader(ph, "Content-Transfer-Encoding");
        const decoded = decodeTransfer(pb, pe);
        if (pct.includes("text/plain") && !plain) plain = decoded;
        else if (pct.includes("text/html") && !html) html = decoded;
      }
    } else {
      const decoded = decodeTransfer(body, cte);
      if (ctype.includes("text/html")) html = decoded;
      else plain = decoded;
    }
    const bodyText = (plain || "").trim() || stripHtmlish(html);
    const lines = [];
    if (subject) lines.push("Subject: " + subject);
    if (from) lines.push("From: " + from);
    if (date) lines.push("Date: " + date);
    if (bodyText) lines.push("", bodyText);
    const text = lines.join("\n").trim();
    if (!text) {
      return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
    }
    return { text, supported: true };
  } catch {
    return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
  }
}

async function extractFileText(filename, data) {
  const ext = extOf(filename);
  if (TEXT_EXTS.has(ext)) {
    return { text: data.toString("utf8"), supported: true };
  }
  if (ext === ".pdf") {
    const parser = new PDFParse({ data });
    try {
      const result = await parser.getText();
      return { text: String(result && result.text != null ? result.text : ""), supported: true };
    } finally {
      try {
        await parser.destroy();
      } catch {
        /* ignore */
      }
    }
  }
  if (ext === ".docx") {
    return extractDocx(data, filename);
  }
  if (ext === ".doc") {
    return extractDoc(data, filename);
  }
  if (ext === ".pptx") {
    return extractPptx(data, filename);
  }
  if (ext === ".ppt") {
    return extractPpt(data, filename);
  }
  if (ext === ".rtf") {
    return extractRtf(data, filename);
  }
  if (ext === ".odt") {
    return extractOdt(data, filename);
  }
  if (ext === ".eml") {
    return extractEml(data, filename);
  }
  if (ext === ".xlsx" || ext === ".xls") {
    try {
      const text = await extractSpreadsheet(data);
      if (!text) {
        return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
      }
      return { text, supported: true };
    } catch {
      return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
    }
  }
  return { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
}

async function ingestText(text, opts = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { status: 400, body: { error: "要有文字先 dump" } };
  const store = load();
  if (!opts.confirm) {
    const dup = store.notes.find((n) => String(n.text || "").trim() === trimmed);
    if (dup) {
      return { status: 409, body: { error: "呢段同已有 note 一樣", duplicateId: dup.id } };
    }
  }
  const ingestedAt = new Date().toISOString();
  const unsupported = !!opts.extractUnsupported;
  const note = {
    id: String(Date.now()) + (opts.idSuffix != null ? String(opts.idSuffix) : ""),
    text: trimmed,
    createdAt: ingestedAt,
    ingestedAt,
    source: opts.source || "paste",
    tags: [],
    summary: unsupported ? UNSUPPORTED_BODY : null,
    classifyError: unsupported ? null : CLASSIFY_FAIL,
    box: normalizeBox(opts.box != null ? opts.box : loadCurrentBox()),
  };
  if (opts.source === "file") {
    note.filename = basenameOnly(opts.filename);
    note.ext = extOf(opts.filename);
    note.bytes = Number(opts.bytes) || 0;
    if (opts.fileModifiedAt) note.fileModifiedAt = String(opts.fileModifiedAt);
  }
  store.notes.unshift(note);
  save(store);
  if (unsupported) {
    await embedNote(note.id, trimmed);
    return { status: 200, body: { ok: true, note, classified: false, question: null } };
  }
  const result = await classify(trimmed);
  const next = load();
  const row = next.notes.find((n) => n.id === note.id) || note;
  let queued = null;
  if (result.ok) {
    row.tags = result.tags;
    row.summary = result.summary;
    row.classifyError = null;
    if (result.question) {
      queued = {
        id: String(Date.now() + 1) + (opts.idSuffix != null ? "q" + String(opts.idSuffix) : ""),
        text: result.question,
        status: "open",
        answer: null,
        noteId: row.id,
        createdAt: new Date().toISOString(),
        suggestions: [],
        suggestError: null,
      };
      const sugOut = await suggestAnswers(queued.text, row.text || trimmed);
      queued.suggestions = sugOut.suggestions || [];
      queued.suggestError = sugOut.ok ? null : (sugOut.error || CLASSIFY_FAIL);
      next.questions.unshift(queued);
    }
  } else {
    row.tags = [];
    row.summary = null;
    row.classifyError = result.error || CLASSIFY_FAIL;
  }
  save(next);
  await embedNote(row.id, row.text || trimmed);
  return { status: 200, body: { ok: true, note: row, classified: !!result.ok, question: queued } };
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



async function suggestAnswers(question, noteText) {
  const listed = await listOllamaModels();
  if (!listed.ok) return { ok: false, error: CLASSIFY_FAIL, suggestions: [] };
  const model = pickDefaultModel(listed.models);
  if (!model) return { ok: false, error: CLASSIFY_NO_TEXT, suggestions: [] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OLLAMA_MS);
  try {
    const r = await fetch(OLLAMA + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        messages: [
          {
            role: "system",
            content:
              'Suggest short answers to a clarifying question about a personal note. JSON only: {"suggestions":["..."]}. Two to four short options. Same language as the question. Do not invent facts that are not in the note.',
          },
          {
            role: "user",
            content: ("Question: " + String(question || "") + "\n\nNote:\n" + String(noteText || "")).slice(0, CLASSIFY_CHARS),
          },
        ],
        options: { num_predict: CLASSIFY_NUM_PREDICT },
      }),
    });
    if (!r.ok) return { ok: false, error: classifyHttpError(r.status), suggestions: [] };
    const data = await r.json();
    const raw = data && data.message && data.message.content;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = String(raw || "").match(/\{[\s\S]*\}/);
      if (!m) return { ok: false, error: "模型回錯誤", suggestions: [] };
      try { parsed = JSON.parse(m[0]); } catch { return { ok: false, error: "模型回錯誤", suggestions: [] }; }
    }
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map((x) => String(x).trim()).filter(Boolean).slice(0, 4)
      : [];
    if (suggestions.length < 2) return { ok: false, error: "模型回錯誤", suggestions: [] };
    return { ok: true, suggestions, error: null };
  } catch (err) {
    return { ok: false, error: classifyCatchError(err), suggestions: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function classify(text) {
  const listed = await listOllamaModels();
  if (!listed.ok) return { ok: false, error: CLASSIFY_FAIL };
  const model = pickDefaultModel(listed.models);
  if (!model) return { ok: false, error: CLASSIFY_NO_TEXT };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OLLAMA_MS);
  try {
    const r = await fetch(OLLAMA + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        messages: [
          {
            role: "system",
            content:
              'Classify a personal note. JSON only: {"tags":["project-or-topic"],"summary":"one sentence","question":null}. Two to five short tags. If the dump is too vague to file, tags may be empty and question must be a short clarifying ask. Do not invent facts that are not in the text.',
          },
          { role: "user", content: String(text).slice(0, CLASSIFY_CHARS) },
        ],
        options: { num_predict: CLASSIFY_NUM_PREDICT },
      }),
    });
    if (!r.ok) return { ok: false, error: classifyHttpError(r.status) };
    const data = await r.json();
    const raw = data && data.message && data.message.content;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = String(raw || "").match(/\{[\s\S]*\}/);
      if (!m) return { ok: false, error: "模型回錯誤" };
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        return { ok: false, error: "模型回錯誤" };
      }
    }
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
      : [];
    const summary = parsed.summary ? String(parsed.summary).trim() : "";
    const question = parsed.question ? String(parsed.question).trim() : "";
    if (!tags.length && !summary && !question) return { ok: false, error: "模型回錯誤" };
    return { ok: true, tags, summary: summary || null, question: question || null };
  } catch (err) {
    return { ok: false, error: classifyCatchError(err) };
  } finally {
    clearTimeout(timer);
  }
}


function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const m = Math.sqrt(na) * Math.sqrt(nb);
  return m ? dot / m : 0;
}

function mergeSearch(keywordNotes, vecNotes) {
  const seen = new Set();
  const out = [];
  for (const n of keywordNotes || []) {
    const id = n && n.id;
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    out.push(n);
  }
  for (const n of vecNotes || []) {
    const id = n && n.id;
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    out.push(n);
  }
  return out;
}

function isEmbedModel(name) {
  const n = String(name || "");
  return n === EMBED_MODEL || n.startsWith(EMBED_MODEL + ":");
}

function loadVectors() {
  try {
    const s = JSON.parse(fs.readFileSync(vectorFile, "utf8"));
    return s && typeof s === "object" && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

function saveVectors(map) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(vectorFile, JSON.stringify(map));
}

function dropVector(id) {
  const map = loadVectors();
  if (map[id]) {
    delete map[id];
    saveVectors(map);
  }
}

const backfillState = { running: false };

function missingVectorIds() {
  const vecs = loadVectors();
  return load().notes.filter((n) => !Array.isArray(vecs[n.id]) || !vecs[n.id].length).map((n) => n.id);
}

async function embedStatus() {
  const listed = await listOllamaModels();
  const missing = missingVectorIds().length;
  if (!listed.ok) return { ok: false, embedder: false, missing, running: backfillState.running };
  return {
    ok: true,
    embedder: listed.models.some(isEmbedModel),
    missing,
    running: backfillState.running,
    model: EMBED_MODEL,
  };
}

async function backfillEmbeddings() {
  if (backfillState.running) return { ok: true, running: true };
  const listed = await listOllamaModels();
  if (!listed.ok || !listed.models.some(isEmbedModel)) {
    return { ok: true, started: false, embedder: !!(listed.ok && listed.models.some(isEmbedModel)), ollama: listed.ok };
  }
  backfillState.running = true;
  try {
    const notes = load().notes;
    const vecs = loadVectors();
    for (const n of notes) {
      if (Array.isArray(vecs[n.id]) && vecs[n.id].length) continue;
      try {
        await embedNote(n.id, n.text || "");
      } catch {
        /* one fail must not stop the rest */
      }
    }
  } finally {
    backfillState.running = false;
  }
  return { ok: true, started: true, missing: missingVectorIds().length, running: false };
}

async function embedText(text) {
  const status = await embedStatus();
  if (!status.ok) return { ok: false, down: true };
  if (!status.embedder) return { ok: false, missing: true };
  const prompt = String(text || "").slice(0, 4000);
  if (!prompt.trim()) return { ok: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    let r = await fetch(OLLAMA + "/api/embed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({ model: EMBED_MODEL, input: prompt }),
    });
    let data = await r.json().catch(() => ({}));
    let vec = Array.isArray(data.embeddings) ? data.embeddings[0] : data.embedding;
    if (!Array.isArray(vec) || !vec.length) {
      r = await fetch(OLLAMA + "/api/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({ model: EMBED_MODEL, prompt }),
      });
      data = await r.json().catch(() => ({}));
      vec = data.embedding;
    }
    if (!Array.isArray(vec) || !vec.length) return { ok: false };
    return { ok: true, embedding: vec };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function embedNote(id, text) {
  const out = await embedText(text);
  if (!out.ok) return out;
  const map = loadVectors();
  map[id] = out.embedding;
  saveVectors(map);
  return out;
}

async function searchAll(q, store) {
  const kw = searchHay(q, store);
  const emb = await embedText(q);
  if (!emb.ok) {
    return { notes: kw.notes, questions: kw.questions, embedder: false, ollama: !emb.down };
  }
  const vecs = loadVectors();
  const scored = [];
  for (const n of store.notes) {
    const v = vecs[n.id];
    if (!Array.isArray(v) || !v.length) continue;
    const s = cosine(emb.embedding, v);
    if (s >= 0.32) scored.push({ n, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const vecNotes = scored.slice(0, 12).map((x) => x.n);
  return {
    notes: mergeSearch(kw.notes, vecNotes),
    questions: kw.questions,
    embedder: true,
    ollama: true,
  };
}

function searchHay(q, store) {
  const needle = q.trim().toLowerCase();
  if (!needle) return { notes: [], questions: [] };
  const notes = store.notes.filter((n) => {
    const blob = [n.text, n.summary, n.filename, n.ext, ...(n.tags || [])].filter(Boolean).join(" ").toLowerCase();
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

  if (method === "GET" && u.pathname === "/api/box") {
    json(res, 200, { box: loadCurrentBox(), boxes: listBoxes(load()) });
    return;
  }

  if (method === "PUT" && u.pathname === "/api/box") {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      json(res, 400, { error: "JSON 唔啱" });
      return;
    }
    const box = normalizeBox(payload.box);
    saveCurrentBox(box);
    json(res, 200, { ok: true, box, boxes: listBoxes(load()) });
    return;
  }

  if (method === "POST" && u.pathname === "/api/boxes/rename") {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      json(res, 400, { error: "JSON 唔啱" });
      return;
    }
    const from = normalizeBox(payload.from);
    const to = normalizeBox(payload.to);
    if (!from || !to) {
      json(res, 400, { error: "要有盒名" });
      return;
    }
    if (from === to) {
      json(res, 400, { error: "盒名冇變" });
      return;
    }
    const store = load();
    const hit = store.notes.filter((n) => normalizeBox(n.box) === from);
    if (!hit.length) {
      json(res, 404, { error: "搵唔到呢個盒" });
      return;
    }
    hit.forEach((n) => { n.box = to; });
    save(store);
    if (loadCurrentBox() === from) saveCurrentBox(to);
    json(res, 200, { ok: true, from, to, moved: hit.length, boxes: listBoxes(load()) });
    return;
  }

  if (method === "POST" && u.pathname === "/api/boxes/unbox") {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      json(res, 400, { error: "JSON 唔啱" });
      return;
    }
    const box = normalizeBox(payload.box);
    if (!box) {
      json(res, 400, { error: "要有盒名" });
      return;
    }
    if (!payload.confirm) {
      json(res, 400, { error: "要確認" });
      return;
    }
    const store = load();
    const hit = store.notes.filter((n) => normalizeBox(n.box) === box);
    if (!hit.length) {
      json(res, 404, { error: "搵唔到呢個盒" });
      return;
    }
    hit.forEach((n) => { n.box = ""; });
    save(store);
    if (loadCurrentBox() === box) saveCurrentBox("");
    json(res, 200, { ok: true, box, unboxed: hit.length, boxes: listBoxes(load()) });
    return;
  }

  if (method === "GET" && u.pathname === "/api/models") {
    const listed = await listOllamaModels();
    if (!listed.ok) {
      json(res, 200, {
        ok: false,
        models: [],
        selected: null,
        defaultModel: DEFAULT_MODEL,
      });
      return;
    }
    const selected = pickDefaultModel(listed.models);
    if (selected) {
      const pref = loadModelPreference();
      if (pref !== selected) saveModelPreference(selected);
    }
    json(res, 200, {
      ok: true,
      models: listed.models,
      selected: selected || null,
      defaultModel: DEFAULT_MODEL,
    });
    return;
  }

  if (method === "PUT" && u.pathname === "/api/model") {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      json(res, 400, { error: "JSON 唔啱" });
      return;
    }
    const wanted = String(payload.model || "").trim();
    if (!wanted) {
      json(res, 400, { error: "要有 model" });
      return;
    }
    const listed = await listOllamaModels();
    if (!listed.ok) {
      json(res, 503, { error: CLASSIFY_FAIL, models: [] });
      return;
    }
    if (!listed.models.includes(wanted)) {
      json(res, 400, { error: "唔喺本機 model 列表", models: listed.models });
      return;
    }
    saveModelPreference(wanted);
    json(res, 200, { ok: true, model: wanted, models: listed.models });
    return;
  }

  if (method === "POST" && u.pathname === "/api/import") {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || "");
    } catch {
      json(res, 400, { error: "備份檔唔啱格式" });
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.notes) || !Array.isArray(payload.questions)) {
      json(res, 400, { error: "備份檔唔啱格式" });
      return;
    }
    const dismissedMerges = Array.isArray(payload.dismissedMerges) ? payload.dismissedMerges : [];
    let nextVectors = {};
    const rawVec = payload.vectors;
    if (rawVec && typeof rawVec === "object" && !Array.isArray(rawVec)) {
      for (const [id, vec] of Object.entries(rawVec)) {
        if (Array.isArray(vec) && vec.length) nextVectors[id] = vec;
      }
    }
    payload.notes.forEach((n) => {
      if (n && typeof n === "object") n.box = normalizeBox(n.box);
    });
    save({ notes: payload.notes, questions: payload.questions, dismissedMerges });
    saveVectors(nextVectors);
    json(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && u.pathname === "/api/import-box") {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || "");
    } catch {
      json(res, 400, { error: "備份檔唔啱格式" });
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.notes) || !Array.isArray(payload.questions)) {
      json(res, 400, { error: "備份檔唔啱格式" });
      return;
    }
    for (const n of payload.notes) {
      if (!n || typeof n !== "object" || Array.isArray(n)) {
        json(res, 400, { error: "備份檔唔啱格式" });
        return;
      }
    }
    const store = load();
    const idMap = {};
    const stamp = Date.now();
    const incoming = [];
    const override = Object.prototype.hasOwnProperty.call(payload, "targetBox");
    const destBox = override ? normalizeBox(payload.targetBox) : null;
    payload.notes.forEach((n, i) => {
      const oldId = String(n.id || "");
      const nid = String(stamp) + "-b" + i + "-" + Math.random().toString(36).slice(2, 7);
      if (oldId) idMap[oldId] = nid;
      incoming.push({
        ...n,
        id: nid,
        box: override ? destBox : normalizeBox(n.box),
      });
    });
    const incomingQs = [];
    (payload.questions || []).forEach((q, i) => {
      if (!q || typeof q !== "object") return;
      const newNote = idMap[String(q.noteId || "")];
      if (!newNote) return;
      incomingQs.push({
        ...q,
        id: String(stamp) + "-bq" + i + "-" + Math.random().toString(36).slice(2, 7),
        noteId: newNote,
      });
    });
    const dismissed = Array.isArray(payload.dismissedMerges) ? payload.dismissedMerges : [];
    const extraDismiss = [];
    dismissed.forEach((k) => {
      const parts = String(k).split("|");
      if (parts.length !== 2) return;
      const a = idMap[parts[0]], b = idMap[parts[1]];
      if (!a || !b) return;
      const key = pairKey(a, b);
      if (!store.dismissedMerges.includes(key) && !extraDismiss.includes(key)) extraDismiss.push(key);
    });
    store.notes = incoming.concat(store.notes);
    store.questions = incomingQs.concat(store.questions || []);
    store.dismissedMerges = (store.dismissedMerges || []).concat(extraDismiss);
    save(store);
    const rawVec = payload.vectors;
    if (rawVec && typeof rawVec === "object" && !Array.isArray(rawVec)) {
      const map = loadVectors();
      for (const [oldId, vec] of Object.entries(rawVec)) {
        const nid = idMap[oldId];
        if (nid && Array.isArray(vec) && vec.length) map[nid] = vec;
      }
      saveVectors(map);
    }
    json(res, 200, { ok: true, added: incoming.length, questions: incomingQs.length });
    return;
  }

  if (method === "POST" && u.pathname === "/api/wipe") {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      json(res, 400, { error: "要確認" });
      return;
    }
    if (!payload || !payload.confirm) {
      json(res, 400, { error: "要確認" });
      return;
    }
    save(emptyStore());
    saveVectors({});
    saveCurrentBox("");
    json(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && u.pathname === "/api/export") {
    const store = load();
    const vecAll = loadVectors();
    let notes = store.notes;
    let questions = store.questions;
    let dismissedMerges = store.dismissedMerges;
    let vectors = vecAll;
    let filename = "info-inbox-backup.json";
    if (u.searchParams.has("box")) {
      const want = normalizeBox(u.searchParams.get("box"));
      notes = store.notes.filter((n) => normalizeBox(n.box) === want);
      const ids = new Set(notes.map((n) => n.id));
      questions = (store.questions || []).filter((q) => q.noteId && ids.has(q.noteId));
      dismissedMerges = (store.dismissedMerges || []).filter((k) => {
        const parts = String(k).split("|");
        return parts.length === 2 && ids.has(parts[0]) && ids.has(parts[1]);
      });
      vectors = {};
      for (const id of ids) {
        if (Array.isArray(vecAll[id]) && vecAll[id].length) vectors[id] = vecAll[id];
      }
      filename = want ? "info-inbox-box-" + want.replace(/[^\w\u4e00-\u9fff-]+/g, "_").slice(0, 40) + ".json" : "info-inbox-unclassified.json";
    }
    const body = JSON.stringify({
      notes,
      questions,
      dismissedMerges,
      vectors,
      exportedAt: new Date().toISOString(),
    }, null, 2);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="' + filename.replace(/"/g, "") + '"',
      "cache-control": "no-store",
    });
    res.end(body);
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
    store.questions = (store.questions || []).filter((q) => {
      if (q.noteId !== id) return true;
      return (q.status || "open") !== "open";
    });
    save(store);
    dropVector(id);
    json(res, 200, { ok: true, deleted: id });
    return;
  }

  if ((method === "PATCH" || method === "PUT") && delNote) {
    const id = decodeURIComponent(delNote[1]);
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      json(res, 400, { error: "JSON 唔啱" });
      return;
    }
    const hasText = Object.prototype.hasOwnProperty.call(payload, "text");
    const hasBox = Object.prototype.hasOwnProperty.call(payload, "box");
    if (!hasText && !hasBox) {
      json(res, 400, { error: "要有文字" });
      return;
    }
    const store = load();
    const row = store.notes.find((n) => n.id === id);
    if (!row) {
      json(res, 404, { error: "搵唔到呢條筆記" });
      return;
    }
    if (hasText) {
      const text = String(payload.text || "").trim();
      if (!text) {
        json(res, 400, { error: "要有文字" });
        return;
      }
      row.text = text;
    }
    if (hasBox) row.box = normalizeBox(payload.box);
    save(store);
    if (hasText) await embedNote(row.id, row.text || "");
    json(res, 200, { ok: true, note: row });
    return;
  }

  if (method === "POST" && u.pathname === "/api/notes/reclassify-missing") {
    const store = load();
    let classified = 0, failed = 0;
    for (const row of store.notes) {
      const need = !!(row.classifyError || !(row.tags || []).length);
      if (!need || row.summary === "未支援抽文字") continue;
      try {
        const result = await classify(row.text || "");
        if (result.ok) {
          row.tags = result.tags;
          row.summary = result.summary;
          row.classifyError = null;
          classified++;
        } else {
          row.classifyError = result.error || CLASSIFY_FAIL;
          failed++;
        }
        await embedNote(row.id, row.text || "");
      } catch {
        failed++;
      }
    }
    save(store);
    json(res, 200, { ok: true, classified, failed });
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
      row.classifyError = result.error || CLASSIFY_FAIL;
    }
    save(store);
    await embedNote(row.id, row.text || "");
    json(res, 200, { ok: true, note: row, classified: !!result.ok });
    return;
  }

  if (method === "GET" && u.pathname === "/api/questions") {
    const store = load();
    const ids = new Set((store.notes || []).map((n) => n.id));
    const questions = (store.questions || []).map((q) => ({
      ...q,
      sourceMissing: !!(q.noteId && !ids.has(q.noteId)),
    }));
    json(res, 200, { questions });
    return;
  }

  if (method === "GET" && u.pathname === "/api/search") {
    const out = await searchAll(u.searchParams.get("q") || "", load());
    json(res, 200, out);
    return;
  }

  if (method === "GET" && u.pathname === "/api/embed-status") {
    json(res, 200, await embedStatus());
    return;
  }

  if (method === "POST" && u.pathname === "/api/embed/backfill") {
    const st = await embedStatus();
    if (!st.ok || !st.embedder) {
      json(res, 200, { ok: true, started: false, embedder: !!st.embedder, ollama: st.ok, missing: st.missing || 0 });
      return;
    }
    backfillEmbeddings().catch(() => {});
    json(res, 200, { ok: true, started: true, running: true, missing: st.missing || 0 });
    return;
  }

  const sugPath = /^\/api\/questions\/([^/]+)\/suggest$/.exec(u.pathname);
  if (method === "POST" && sugPath) {
    const id = decodeURIComponent(sugPath[1]);
    const store = load();
    const row = store.questions.find((q) => q.id === id);
    if (!row) {
      json(res, 404, { error: "搵唔到呢條問題" });
      return;
    }
    if ((row.status || "open") !== "open") {
      json(res, 409, { error: "呢條已答過" });
      return;
    }
    let payload = {};
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      payload = {};
    }
    const force = !!payload.force;
    if (!force && Array.isArray(row.suggestions) && row.suggestions.length >= 2) {
      json(res, 200, { ok: true, question: row });
      return;
    }
    const note = store.notes.find((n) => n.id === row.noteId);
    const sugOut = await suggestAnswers(row.text, note && note.text);
    row.suggestions = sugOut.suggestions || [];
    row.suggestError = sugOut.ok ? null : (sugOut.error || CLASSIFY_FAIL);
    save(store);
    json(res, 200, { ok: !!sugOut.ok, question: row, error: row.suggestError });
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
    const result = await classify(src.text || "");
    if (result.ok) {
      src.tags = result.tags;
      src.summary = result.summary;
      src.classifyError = null;
    } else {
      src.classifyError = result.error || CLASSIFY_FAIL;
    }
    save(store);
    await embedNote(src.id, src.text || "");
    json(res, 200, { ok: true, question: row, note: src, classified: !!result.ok });
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
    if (normalizeBox(a.box) !== normalizeBox(b.box)) {
      json(res, 400, { error: "唔同盒唔合併" });
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
    keep.box = normalizeBox(keep.box) || normalizeBox(drop.box);
    const dropKey = drop.id;
    store.notes = store.notes.filter((n) => n.id !== dropKey);
    store.dismissedMerges = store.dismissedMerges.filter((k) => !k.split("|").includes(dropKey) && !k.split("|").includes(keep.id));
    save(store);
    dropVector(dropKey);
    await embedNote(keep.id, keep.text || "");
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
    const box = normalizeBox(payload.box != null ? payload.box : loadCurrentBox());
    saveCurrentBox(box);
    const out = await ingestText(payload.text, {
      confirm: !!payload.confirm,
      source: "paste",
      box,
    });
    json(res, out.status, out.body);
    return;
  }

  if (method === "POST" && u.pathname === "/api/ingest-files") {
    const ctype = String(req.headers["content-type"] || "");
    const m = /multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
    if (!m) {
      json(res, 400, { error: "要 multipart" });
      return;
    }
    const boundary = (m[1] || m[2] || "").trim();
    if (!boundary) {
      json(res, 400, { error: "要 multipart" });
      return;
    }
    let raw;
    try {
      raw = await readRawBody(req);
    } catch {
      json(res, 400, { error: "讀唔到檔" });
      return;
    }
    const parts = parseMultipart(raw, boundary);
    const confirm = parts.some(
      (p) => p.name === "confirm" && !p.filename && /^(1|true|yes)$/i.test(p.data.toString("utf8").trim())
    );
    const boxPart = parts.find((p) => p.name === "box" && !p.filename);
    const box = normalizeBox(boxPart ? boxPart.data.toString("utf8") : loadCurrentBox());
    saveCurrentBox(box);
    const modifiedParts = parts.filter((p) => p.name === "fileModifiedAt" && !p.filename);
    const fileParts = parts.filter((p) => p.filename != null && (p.name === "file" || p.name === "files"));
    if (!fileParts.length) {
      json(res, 400, { error: "要有檔" });
      return;
    }
    const results = [];
    for (let i = 0; i < fileParts.length; i++) {
      const part = fileParts[i];
      const filename = basenameOnly(part.filename);
      let fileModifiedAt = null;
      const modPart = modifiedParts[i];
      if (modPart) {
        const rawMod = modPart.data.toString("utf8").trim();
        if (rawMod) fileModifiedAt = rawMod;
      }
      let extracted;
      try {
        extracted = await extractFileText(filename, part.data);
      } catch {
        extracted = { text: basenameOnly(filename) + "\n" + UNSUPPORTED_BODY, supported: false };
      }
      const out = await ingestText(extracted.text, {
        confirm,
        source: "file",
        box,
        filename,
        bytes: part.data.length,
        fileModifiedAt,
        extractUnsupported: !extracted.supported,
        idSuffix: "-" + i + "-" + Math.random().toString(36).slice(2, 7),
      });
      if (out.status === 409) {
        json(res, 409, {
          error: out.body.error,
          duplicateId: out.body.duplicateId,
          filename,
          index: i,
          done: results,
        });
        return;
      }
      if (out.status !== 200) {
        results.push({ ok: false, error: (out.body && out.body.error) || "存唔到", filename, index: i });
        continue;
      }
      results.push(out.body);
    }
    json(res, 200, { ok: true, results });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.listen(PORT, BIND, () => {
  console.log("info-inbox http://" + BIND + ":" + PORT + "/");
  setTimeout(() => {
    backfillEmbeddings().catch(() => {});
  }, 400);
});
