# 入盒

Local inbox for scattered notes. Dump text, classify later with a local Ollama model, answer pending questions, search. Data stays on this machine. Not a full PKM.

No cloud. No lan-vnc, heui-bin, or mesh-lan.

## Open

Need Node 18+.

    git clone https://github.com/hkclaw/info-inbox.git && cd info-inbox && npm i && npm start

Then open http://127.0.0.1:3741/  Empty inbox on first run. Listens on 127.0.0.1 only. Do not publish this to the public internet. The UI shell is a notes-app layout (sidebar + editor), not a form dashboard.

Empty Dump shows three short steps (paste/drop → local Ollama → Pending when vague) and says data stays on this machine with no cloud; when Ollama is up it shows ready plus the selected model, when down the existing serve/pull hints stay. The block hides once any note exists and never blocks paste, multi-file drop, or 存入.

## V1 (today)

- Dump a block of text. Exact-duplicate text (trim, not fuzzy) warns 「呢段同已有 note 一樣」 and needs 仍然存入. Dump also accepts files (txt/md/csv/json/html/log/pdf/xlsx/xls/docx/pptx locally; other types still become a note with 「未支援抽文字」). Ollama llama3.2 at http://127.0.0.1:11434 writes tags + a one-line summary; if it is down the note stays, tags stay empty, and the page shows 「連唔到 Ollama（127.0.0.1:11434）」. No invented tags.
- When Ollama is down, Dump shows setup (`ollama serve` / `ollama pull …`) and the model picker stays empty until tags load.
- Notes list. Click a tag to filter; 「清篩選／顯示全部」 clears. 編輯 PATCHes text only. 刪除 is DELETE /api/notes/:id. Empty tags or classifyError show 「重新分類」.
- Search finds notes and questions (text / summary / tags / filename / ext). With local Ollama `nomic-embed-text`, Dump stores a vector per note and Search mixes keyword with cosine; if the embedder is missing it stays keyword-only and Search shows `ollama pull nomic-embed-text` (not 連唔到 while 11434 is up).
- Pending: open items have a reply box and 「睇來源筆記」. Answering appends 「（澄清）答：…」 to the source note and reclassifies it. Answered cards stay with 「答：…」.
- Merge tab: overlapping pairs, accept or dismiss. Does not auto-rewrite the inbox.
- Tabs: Dump / Notes / Search / Pending / Merge / 圖譜. Localhost 127.0.0.1:3741 only.
- Graph tab: notes as hollow copper nodes; tags are smaller hollow hubs. Notes link to tags (not note↔note from one shared tag). Merge and pending stay note↔note (pending dashed). Labels cap at 16 characters. Click a note to jump to Notes. Pan/zoom; tag chips filter. Empty inbox shows 「未有筆記」. Local canvas, no cloud.

## Classify

Needs a local Ollama. Default model llama3.2 at http://127.0.0.1:11434. On Dump you can pick a local Ollama model from the pulled list; if llama3.2 is pulled, reload selects it. Auto-pick never chooses VL/vision or a 27b/32b name; if none of the pulled models are suitable the picker stays empty and Dump shows 「未有合適文字模型」 plus `ollama pull llama3.2`. Manual PUT can still choose a VL model. Classify sends the first 4k characters, num_predict 256, timeout 90s.

    ollama serve
    ollama pull llama3.2

If Ollama is down, Dump shows setup steps (`ollama serve` / `ollama pull …`) beside the empty model list. Dump still saves if the model is offline. Unreachable 11434 shows 「連唔到 Ollama（127.0.0.1:11434）」. A reachable model that returns HTTP 500 shows 「模型回錯誤（HTTP 500）」; a timeout shows 「模型回逾時」. No invented tags. Vague dumps may enqueue an open question. Answer on the Pending tab (textarea + 送出) or POST /api/questions/:id/answer with { "answer": "..." }. That stores the answer, sets status to answered, and appends 「（澄清）答：…」 to the source note. Pending cards with a noteId have 「睇來源筆記」 to jump to that note. Already answered, missing noteId, and missing source note return a clear error. After a successful answer the source note is reclassified with the same local Ollama (llama3.2). If Ollama is down the clarification still stays on the note, tags are not invented, and 「連唔到 Ollama（127.0.0.1:11434）」 is shown.

## Merge

Overlapping notes (shared tags or similar text) show as suggestions. Nothing is rewritten until you accept.

GET /api/merge-suggestions lists pairs (note ids + a short reason). Accept merges bodies, unions tags, keeps one summary (rewrites with Ollama only if it is up), and deletes the other id. Dismiss leaves both notes. Stored in data/. Localhost only, no cloud.

## Notes

Click a tag chip on the Notes tab to show only notes with that tag. 「清篩選／顯示全部」 clears the filter.

Each card has 編輯 (textarea, 儲存／取消) to PATCH /api/notes/:id with { "text" }. Empty text returns 「要有文字」. Tags, summary, and classifyError are left as-is; use 「重新分類」 if you want a new classify. Each card has 刪除. Confirm runs DELETE /api/notes/:id and removes that note from data/. Missing ids return 「搵唔到呢條筆記」. Questions are not deleted with the note.

Notes with a classifyError or no tags show 「重新分類」. That POSTs /api/notes/:id/reclassify to the same local Ollama (llama3.2). Success writes tags and summary; if Ollama is down the text stays, tags are not invented, and 「連唔到 Ollama（127.0.0.1:11434）」 is shown.

## Backup

Click 「下載備份」 on the page (GET /api/export). One JSON file with notes, pending questions, merge dismissals, and the vectors map. 「還原備份」 POSTs that JSON to /api/import and replaces the whole local store and vectors after confirm. Old backups with no vectors (or an empty map) clear embeddings so Search stays keyword-only and does not crash. Bad files return 「備份檔唔啱格式」 and write nothing. Stays on this machine.

## Data

JSON file under data/ (gitignored). Notes: id, text, createdAt, ingestedAt, source (paste | file), filename/ext/bytes/fileModifiedAt (file only), tags, summary, classifyError, clarifications. Questions: id, text, status (open | answered), answer, noteId, createdAt. dismissedMerges stores dismissed pair keys.

Merge later means overlapping notes, not rewriting the whole inbox.
