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
- Pending questions queue (empty until the model asks)
- POST /api/ingest stores the dump locally. Classification via Ollama http://127.0.0.1:11434 (llama3.2) is not wired in this slice; ingest does not invent tags. If the model is offline later, the page must show a visible error instead of a fake category.

## Data

JSON file under data/ (gitignored). Notes: id, text, createdAt, tags, summary, classifyError. Questions: id, text, status (open | answered), answer, createdAt.

Merge later means overlapping notes, not rewriting the whole inbox.
