/** Type definition for the Electron preload API exposed via contextBridge */
export interface ElectronAPI {
  platform: string;

  // Dialog
  showOpenDialog: (opts: {
    title?: string;
    filters?: { name: string; extensions: string[] }[];
    properties?: string[];
  }) => Promise<string[]>;
  showSaveDialog: (opts: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<string | null>;

  // File system
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  /** Writes raw bytes — used to save rendered WAV takes without a base64 round trip. */
  writeBinaryFile: (path: string, data: ArrayBuffer) => Promise<string>;
  /** Absolute path of the app's recordings folder (created on first call). */
  recordingsDir: () => Promise<string>;
  showItemInFolder: (path: string) => Promise<void>;

  // Shell
  openExternal: (url: string) => Promise<void>;

  // Notifications
  showNotification: (title: string, body: string) => Promise<void>;

  // Window controls
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;

  // Events
  onDeepLink: (cb: (url: string) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export function getDesktopAPI(): ElectronAPI | null {
  return window.electronAPI ?? null;
}

export function isDesktop(): boolean {
  return getDesktopAPI() !== null;
}
