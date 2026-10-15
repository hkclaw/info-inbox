# 入盒

本機用嘅筆記入口。先把散亂文字同檔案倒入去，之後先分類、答問題、搜尋。資料留喺呢部機，唔係一套完整嘅知識庫。

介面只聽 `127.0.0.1`。唔好公開到互聯網。

## 打開

要 Node 18 或更新。

```bash
git clone https://github.com/hkclaw/info-inbox.git
cd info-inbox
npm i
npm start
```

然後開 [http://127.0.0.1:3741/](http://127.0.0.1:3741/)。第一次係空盒。

Mac 視窗用同一部伺服器：

```bash
npm i
npm run electron
```

瀏覽器版嘅資料喺專案入面嘅 `data/`。Electron 版預設寫去 userData 入面嘅 `data/`。兩邊都可以用 `INFO_INBOX_DATA` 指去另一個資料夾。程式唔會包埋 Ollama。

## 頁面

| 頁 | 做咩 |
| --- | --- |
| 傾倒 | 貼文字、拖檔或者拖資料夾，然後存入 |
| 筆記 | 睇、改文字、改 tag、搬去另一個盒 |
| 搜尋 | 用關鍵字搵，或者問呢個盒 |
| 待答 | 太含糊、要你補充嘅問題 |
| 合併 | 重疊筆記嘅建議；你接受先會改寫 |
| 圖譜 | 筆記同 tag 嘅關係，可以拖同縮放 |

右上角 **資料** 先至係備份、匯入、還原同清空。

## 點用

1. 喺傾倒貼一段文字，或者拖檔入去，撳 **存入**。
2. 本機模型會寫幾個 tag 同一行摘要。太含糊就會去待答。
3. 筆記可以放入命名盒。留空就係未分類。盒唔會再疊盒。
4. 搜尋會搵文字、摘要、tag 同檔名。拉咗 `nomic-embed-text` 之後，會一齊用向量。

完全一樣嘅文字（去頭尾空白，唔係模糊比對）會問你係咪仍然存入。

支援抽文字嘅格式：txt、md、csv、json、html、log、pdf、xlsx、xls、docx、doc、pptx、ppt、rtf、odt、eml。其他類型仍然會成一條筆記，內容係檔名加「未支援抽文字」。圖片只留檔名。`.eml` 會留 Subject、From、Date 同純文字正文。

模型離線都一樣存到筆記。Tag 唔會憑空捏造。

## 模型

預設係本機 Ollama 嘅 `llama3.2`，位址 `http://127.0.0.1:11434`。

```bash
ollama serve
ollama pull llama3.2
ollama pull nomic-embed-text
```

分類只送頭 4000 字，約 90 秒超時。自動揀模型會跳過 vision，同埋個名有 27b、32b 嘅模型。如果 llama3.2 已經拉咗，重新載入會揀返佢。

`nomic-embed-text` 用嚟做搜尋向量。未拉嘅話，搜尋繼續用關鍵字，頁面會提示你拉模型，唔會假裝連唔到。

### Open WebUI

可選。唔設嘅話，仍然只用上面嘅 Ollama。

喺傾倒頁把 **後端** 改做 Open WebUI，填網址同 API key，再撳 **儲存**。或者啟動前設：

```bash
LLM_BACKEND=openwebui
OPENWEBUI_URL=http://127.0.0.1:8080
OPENWEBUI_API_KEY=你的金鑰
```

網址只接受 `http` 同 `https`。API key 寫入 `data/llm.json`，介面唔會再顯示出嚟。分類、建議同「問呢個盒」走 Open WebUI 嘅 `POST /api/chat/completions`；模型清單係 `GET /api/models`。向量會先試 `POST /api/embeddings`，再試 Ollama proxy。筆記文字只會送到你填嘅呢個網址。

連唔到會顯示「連唔到 Open WebUI（host:port）」。401 或 403 會顯示「Open WebUI 要 API key」。

常用環境變數：

| 變數 | 預設 | 用途 |
| --- | --- | --- |
| `PORT` | `3741` | 本機埠 |
| `BIND` | `127.0.0.1` | 只綁呢個位址 |
| `INFO_INBOX_DATA` | 專案 `data/` | 資料夾 |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama |
| `OLLAMA_MODEL` | `llama3.2` | 文字模型 |
| `OLLAMA_EMBED` | `nomic-embed-text` | 向量模型 |
| `OPENWEBUI_EMBED` | 跟 `OLLAMA_EMBED` | Open WebUI 向量模型 |

## 備份

全部喺 **資料** 選單。

- **下載備份**：成個 inbox 一個 JSON，包括筆記、待答、合併記錄同向量。
- **匯出呢個盒**：只匯出而家篩緊嘅盒。「全部」仍然係成個備份。
- **匯入盒備份**：合併入去。其他盒留低。目標盒入面已經有同樣文字嘅筆記會跳過。
- **還原備份**：確認之後換晒成部機嘅資料。
- **清空本機資料**：筆記、問題、合併記錄同向量一齊清走。

格式唔啱會回「備份檔唔啱格式」，唔會寫入。

## 資料

`data/` 唔會入 git。

| 檔 | 內容 |
| --- | --- |
| `inbox.json` | 筆記、待答問題、已忽略嘅合併 |
| `vectors.json` | 搜尋向量 |
| `llm.json` | Open WebUI 網址同 API key |
| `ollama-model.json` | 而家揀咗嘅文字模型 |
| `current-box.json` | 盒名單同而家嘅盒 |

## 測試

```bash
npm test
```
