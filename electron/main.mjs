import { app, BrowserWindow, shell } from "electron";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const BIND = process.env.BIND || "127.0.0.1";
const PORT = Number(process.env.PORT || 3741);

process.env.BIND = BIND;
process.env.PORT = String(PORT);
if (!process.env.INFO_INBOX_DATA) {
  process.env.INFO_INBOX_DATA = path.join(app.getPath("userData"), "data");
}

await import(path.join(root, "server.mjs"));

function waitForServer(ms = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get("http://" + BIND + ":" + PORT + "/", (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - started > ms) reject(new Error("server did not start"));
        else setTimeout(tick, 150);
      });
    };
    tick();
  });
}

let win;

async function createWindow() {
  await waitForServer();
  win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 720,
    minHeight: 480,
    title: "入盒 Hap",
    backgroundColor: "#1c1916",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.loadURL("http://" + BIND + ":" + PORT + "/");
  // Keep folder/file drops on Dump; don't navigate the window to file://.
  win.webContents.on("will-navigate", (event, url) => {
    const ok = "http://" + BIND + ":" + PORT;
    if (!url.startsWith(ok)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
