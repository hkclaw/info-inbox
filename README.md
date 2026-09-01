# info-inbox

Local inbox for scattered notes. Dump text, classify later with a local Ollama model, answer pending questions, search. Data stays on this machine. Not a full PKM.

No cloud. No lan-vnc, heui-bin, or mesh-lan.

## Open

Need Node 18+.

    git clone https://github.com/hkclaw/info-inbox.git && cd info-inbox && npm i && npm start

Then open http://127.0.0.1:3741/  Empty inbox on first run. Listens on 127.0.0.1 only. Do not publish this to the public internet.

## V1 (today)

- Dump a block of text
- See notes (empty until you dump)
- Search notes and questions
- Merge tab: overlapping pairs, accept or dismiss (does not auto-rewrite the inbox)
- Pending questions queue (empty until the model asks). Open items have a reply box; answered stay in the list with 「答：…」
- POST /api/ingest stores the dump, then classifies with Ollama at http://127.0.0.1:11434 (llama3.2). Success writes tags and a one-line summary and clears classifyError. If Ollama is down, the note stays, tags stay empty, and the page shows 「連唔到 Ollama（127.0.0.1:11434）」. No invented tags.

## Classify

Needs a local Ollama. Default model llama3.2 at http://127.0.0.1:11434.

    ollama serve
    ollama pull llama3.2

Dump still saves if the model is offline. The page then shows 「連唔到 Ollama（127.0.0.1:11434）」 and does not invent tags. Vague dumps may enqueue an open question. Answer on the Pending tab (textarea + 送出) or POST /api/questions/:id/answer with { "answer": "..." }. That stores the answer, sets status to answered, and appends 「（澄清）答：…」 to the source note. Pending cards with a noteId have 「睇來源筆記」 to jump to that note. Already answered, missing noteId, and missing source note return a clear error. After a successful answer the source note is reclassified with the same local Ollama (llama3.2). If Ollama is down the clarification still stays on the note, tags are not invented, and 「連唔到 Ollama（127.0.0.1:11434）」 is shown.

## Merge

Overlapping notes (shared tags or similar text) show as suggestions. Nothing is rewritten until you accept.

GET /api/merge-suggestions lists pairs (note ids + a short reason). Accept merges bodies, unions tags, keeps one summary (rewrites with Ollama only if it is up), and deletes the other id. Dismiss leaves both notes. Stored in data/. Localhost only, no cloud.

## Notes

Click a tag chip on the Notes tab to show only notes with that tag. 「清篩選／顯示全部」 clears the filter.

Each card has 刪除. Confirm runs DELETE /api/notes/:id and removes that note from data/. Missing ids return 「搵唔到呢條筆記」. Questions are not deleted with the note.

Notes with a classifyError or no tags show 「重新分類」. That POSTs /api/notes/:id/reclassify to the same local Ollama (llama3.2). Success writes tags and summary; if Ollama is down the text stays, tags are not invented, and 「連唔到 Ollama（127.0.0.1:11434）」 is shown.

## Data

JSON file under data/ (gitignored). Notes: id, text, createdAt, tags, summary, classifyError. Questions: id, text, status (open | answered), answer, createdAt.

Merge later means overlapping notes, not rewriting the whole inbox.
