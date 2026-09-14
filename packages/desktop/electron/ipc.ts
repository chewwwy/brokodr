import { ipcMain, dialog, Notification, shell, app, type BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

// Starter IPC handlers backing window.electronAPI (see preload.ts and
// packages/web/src/web/lib/desktop.ts). Fully editable — change, remove, or add
// handlers to fit the app; keep the preload methods and web types in sync.
// openExternal and onDeepLink come from @runablehq/managed-auth (wired in
// preload.ts), not from here.

export function registerIpcHandlers(getWindow: () => BrowserWindow | null) {
  // Dialog
  ipcMain.handle("dialog:open", async (_, opts) => {
    const result = await dialog.showOpenDialog(opts);
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("dialog:save", async (_, opts) => {
    const result = await dialog.showSaveDialog(opts);
    return result.canceled ? null : result.filePath;
  });

  // File system
  ipcMain.handle("fs:read", async (_, filePath: string) => {
    return fs.readFile(filePath, "utf-8");
  });

  ipcMain.handle("fs:write", async (_, filePath: string, data: string) => {
    await fs.writeFile(filePath, data, "utf-8");
  });

  /**
   * Binary write, used by the recorder to put a rendered WAV on disk.
   *
   * The renderer hands over an ArrayBuffer; structured clone moves it across IPC without
   * base64, which matters when a five minute 24-bit stereo take is ~85 MB.
   */
  ipcMain.handle("fs:writeBinary", async (_, filePath: string, data: ArrayBuffer) => {
    await fs.writeFile(filePath, Buffer.from(data));
    return filePath;
  });

  /**
   * Binary read — the inverse of the above, and what restores a kit's pad audio on
   * launch. Returns the bytes themselves rather than a path: BROBEATS samples are
   * one-shots of a few hundred kilobytes, and handing back an ArrayBuffer means the
   * renderer can decode straight into the voice with no AudioContext and no fetch().
   */
  ipcMain.handle("fs:readBinary", async (_, filePath: string) => {
    const buf = await fs.readFile(filePath);
    // Slice to the exact view: Node pools small Buffers, so handing over `buf.buffer`
    // raw would ship the whole pool — other files' bytes included — across IPC.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  ipcMain.handle("fs:delete", async (_, filePath: string) => {
    await fs.rm(filePath, { force: true });
  });

  /** Default place to drop recordings: the OS Music folder, created if missing. */
  ipcMain.handle("fs:recordingsDir", async () => {
    const dir = path.join(app.getPath("music"), "Bro.Kodr");
    await fs.mkdir(dir, { recursive: true });
    return dir;
  });

  /**
   * The sample library: a Samples folder beside the recordings, created if missing.
   *
   * Under Music/Bro.Kodr rather than in appData on purpose — these are the user's
   * sounds. They should be visible, backed up with the rest of their music, and still
   * there after a reinstall, which is not true of anything in a profile directory.
   */
  ipcMain.handle("fs:samplesDir", async () => {
    const dir = path.join(app.getPath("music"), "Bro.Kodr", "Samples");
    await fs.mkdir(dir, { recursive: true });
    return dir;
  });

  ipcMain.handle("shell:showItemInFolder", (_, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  // Notifications
  ipcMain.handle("notification:show", (_, title: string, body: string) => {
    new Notification({ title, body }).show();
  });

  // Window controls
  ipcMain.handle("window:minimize", () => getWindow()?.minimize());
  ipcMain.handle("window:maximize", () => {
    const win = getWindow();
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });
  ipcMain.handle("window:close", () => getWindow()?.close());
}
