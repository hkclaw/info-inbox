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
- POST /api/ingest stores the dump, then classifies with Ollama at http://127.0.0.1:11434 (llama3.2). Success writes tags and a one-line summary and clears classifyError. If Ollama is down, the note stays, tags stay empty, and the page shows 「連唔到 Ollama（127.0.0.1:11434）」. No invented tags.

## Classify

Needs a local Ollama. Default model llama3.2 at http://127.0.0.1:11434.

    ollama serve
    ollama pull llama3.2

Dump still saves if the model is offline. The page then shows 「連唔到 Ollama（127.0.0.1:11434）」 and does not invent tags. Vague dumps may enqueue an open question; answering is not in this slice.

## Data

JSON file under data/ (gitignored). Notes: id, text, createdAt, tags, summary, classifyError. Questions: id, text, status (open | answered), answer, createdAt.

Merge later means overlapping notes, not rewriting the whole inbox.
