import { app, BrowserWindow, session } from "electron";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createManagedDeepLinks } from "@runablehq/managed-auth/desktop/main";
import { registerIpcHandlers } from "./ipc";

// Fully editable Electron main process — own the window, lifecycle, menus, tray,
// and IPC (starter handlers in ./ipc.ts). One platform call is enforced by
// `bun run lint`: createManagedDeepLinks. It registers the app's
// runable-<APPLICATION_ID> deep-link protocol, forwards deep links to the
// renderer, and backs managed sign-in (skills/app/references/desktop.md).

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Dev vs packaged.
 *
 * This MUST key off `app.isPackaged`, not NODE_ENV. Electron does not set NODE_ENV in a
 * packaged build, so `NODE_ENV !== "production"` is true inside the installed .exe — the
 * app then tries to load the Vite dev server, which is not running on a user's machine,
 * and you get a blank window with no error. `BROKODR_DEV_URL` stays as an escape hatch for
 * pointing a packaged build at a running dev server while debugging.
 */
const isDev = !app.isPackaged;
const WEB_DEV_URL = process.env.BROKODR_DEV_URL ?? process.env.WEBSITE_URL ?? "http://localhost:4200";

/**
 * The built web app, copied here by `scripts/copy-web-dist.mjs` during the desktop build
 * and bundled by electron-builder via the `web-dist` entry in its `files` list.
 * In a packaged app __dirname is inside app.asar, so this resolves to
 * `.../app.asar/web-dist`, which asar serves transparently through fs.
 */
const WEB_DIST = path.join(__dirname, "../web-dist");

let win: BrowserWindow | null = null;
const getWindow = () => win;

const deepLinks = createManagedDeepLinks({
  applicationId: process.env.APPLICATION_ID,
  getWindow,
});

// ---------------------------------------------------------------------------
// Chromium switches that matter for a real-time audio app.
//
// SharedArrayBuffer: the audio engine's UI<->audio-thread transport is a lock-free
// SAB ring buffer. Enabling the feature here means we get it even in contexts that
// are not cross-origin isolated; the renderer probes for it and degrades to
// postMessage if the switch ever stops working.
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");
// Let the AudioContext start without a click. The user pressing "Start Engine" is a
// gesture anyway, but this avoids a suspended context after a device change.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// Chromium's own AGC/NS/AEC are switched off per-track in getUserMedia constraints.
// This kills the module entirely so it cannot re-enable itself on a device change.
app.commandLine.appendSwitch("disable-features", "WebRtcAllowInputVolumeAdjustment");

/**
 * Production renderer host.
 *
 * The packaged app deliberately does NOT use `loadFile()`/`file://`, for two reasons that
 * are both hard requirements here:
 *   1. `file://` is not a secure context in Chromium, so `getUserMedia` (microphone) and
 *      Web MIDI are unavailable — the app would be unusable.
 *   2. We need to send COOP/COEP headers to unlock SharedArrayBuffer, and absolute asset
 *      paths like `/dsp/worklet-processor.js` must resolve.
 *
 * `http://127.0.0.1` IS a secure context, so a tiny loopback static server solves all
 * three. It binds to a random free port on the loopback interface only.
 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

function startLocalServer(rootDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const isolation = {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "credentialless",
      };
      let pathname = "/";
      try {
        pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
      } catch {
        pathname = "/";
      }
      // Normalise and confine to the dist directory — no traversal out of it.
      const rel = path.normalize(pathname).replace(/^([/\\])+/, "");
      let filePath = path.join(rootDir, rel);
      if (!filePath.startsWith(rootDir)) filePath = path.join(rootDir, "index.html");

      const missing = !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory();
      if (missing) {
        // Only fall back to index.html for navigation-style requests. A missing *asset*
        // must 404: serving index.html in its place would hand HTML to
        // AudioWorklet.addModule() and produce a baffling syntax error instead of a
        // straightforward "file not found".
        if (path.extname(rel)) {
          res.writeHead(404, { ...isolation, "Content-Type": "text/plain; charset=utf-8" });
          res.end(`Not found: /${rel}`);
          return;
        }
        filePath = path.join(rootDir, "index.html");
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        ...isolation,
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(filePath).pipe(res);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(`http://127.0.0.1:${addr.port}`);
      else reject(new Error("Failed to bind the local renderer server"));
    });
  });
}

async function createWindow() {
  // Microphone access is the whole point of this app, so grant it for our own origin
  // instead of showing a prompt the user cannot meaningfully answer in a desktop shell.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media" || permission === "midi" || permission === "midiSysex");
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === "media" || permission === "midi" || permission === "midiSysex";
  });

  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#07080b",
    title: "Bro.Kodr",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Audio glitches when the renderer is throttled in the background — a voice
      // processor must keep running while you use another window.
      backgroundThrottling: false,
    },
  });

  win.once("ready-to-show", () => win?.show());

  // A blank window with no explanation is the worst possible failure mode, and it is the
  // one this app is most prone to (renderer served over loopback, DSP loaded at runtime).
  // Always show *something* that says what went wrong.
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (code === -3) return; // ERR_ABORTED — a superseded navigation, not a failure.
    showFatal(`Failed to load the interface.\n\n${desc} (${code})\n${url}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    showFatal(`The renderer process stopped: ${details.reason}`);
  });

  if (isDev) {
    await win.loadURL(WEB_DEV_URL).catch(() => {
      /* did-fail-load reports it */
    });
    return;
  }

  if (!fs.existsSync(path.join(WEB_DIST, "index.html"))) {
    showFatal(
      "This build is missing its web assets (web-dist/index.html).\n\n" +
        "The desktop package was built without the copy step. From the repo root run:\n\n" +
        "    bun run build\n    cd packages/desktop && bun run dist",
    );
    return;
  }

  try {
    const origin = await startLocalServer(WEB_DIST);
    await win.loadURL(origin);
  } catch (err) {
    showFatal(`Could not start the local renderer server.\n\n${String(err)}`);
  }
}

/**
 * Renders a plain-text diagnostic straight into the window. Deliberately a data: URL with
 * no assets, so it works even when everything else is broken.
 */
function showFatal(message: string) {
  if (!win) return;
  const body = message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
  const html =
    `<html><body style="margin:0;background:#07080b;color:#e6e8ee;` +
    `font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;padding:32px">` +
    `<div style="color:#ffb020;font-weight:700;letter-spacing:.08em;margin-bottom:16px">` +
    `Bro.Kodr — STARTUP FAILED</div><pre style="white-space:pre-wrap;margin:0">${body}</pre>` +
    `</body></html>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.show();
}

registerIpcHandlers(getWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

// Windows/Linux deliver deep links as argv — of a second instance while the app
// is running, of this instance on cold start. Keep one instance and forward both.
const gotLock = app.requestSingleInstanceLock();
console.log(`[brokodr] isPackaged=${app.isPackaged} gotLock=${gotLock} webDist=${WEB_DIST}`);
if (gotLock) {
  app.on("second-instance", (_event, argv) => deepLinks.handleArgv(argv));
  app.whenReady().then(async () => {
    try {
      await createWindow();
    } catch (err) {
      console.error("[brokodr] createWindow failed", err);
    }
    deepLinks.handleArgv(process.argv);
  });
} else {
  console.log("[brokodr] another instance holds the lock — quitting");
  app.quit();
}
