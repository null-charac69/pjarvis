import { app, BrowserWindow, globalShortcut, ipcMain, shell, session } from "electron";
import Store from "electron-store";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import {
  defaultDesktopPreferences,
  DesktopPreferencesPatchSchema,
  DesktopPreferencesSchema,
  ExternalUrlSchema,
  ipcChannels,
  type DesktopPreferences,
} from "./contracts";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const preferenceStore = new Store<{ preferences: DesktopPreferences }>({
  name: "jarvis-desktop",
  defaults: { preferences: defaultDesktopPreferences },
});

let mainWindow: BrowserWindow | null = null;

export function backendBaseUrl(): string {
  const candidate = process.env.JARVIS_BACKEND_URL ?? "http://localhost:8765";
  const url = new URL(candidate);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("JARVIS_BACKEND_URL must be a credential-free HTTP(S) origin.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error("Remote JARVIS_BACKEND_URL origins must use HTTPS.");
  }
  return url.origin;
}

export function displayName(): string {
  const configuredName = process.env.JARVIS_DISPLAY_NAME?.trim();
  return configuredName ? configuredName.slice(0, 64) : "Local Assistant";
}

function assertMainWindow(sender: Electron.WebContents): void {
  if (!mainWindow || sender !== mainWindow.webContents) {
    throw new Error("Desktop IPC is available only to the application window.");
  }
}

function isInternalNavigation(target: string): boolean {
  if (app.isPackaged) {
    try {
      const destination = new URL(target);
      destination.hash = "";
      destination.search = "";
      return destination.href === pathToFileURL(join(currentDirectory, "../renderer/index.html")).href;
    } catch {
      return false;
    }
  }
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  try {
    return Boolean(rendererUrl && new URL(target).origin === new URL(rendererUrl).origin);
  } catch {
    return false;
  }
}

async function openApprovedExternalUrl(candidate: unknown): Promise<boolean> {
  const url = ExternalUrlSchema.parse(candidate);
  await shell.openExternal(url);
  return true;
}

function registerIpcHandlers(): void {
  ipcMain.handle(ipcChannels.getBackendBaseUrl, (event) => {
    assertMainWindow(event.sender);
    return backendBaseUrl();
  });
  ipcMain.handle(ipcChannels.getPreferences, (event) => {
    assertMainWindow(event.sender);
    return DesktopPreferencesSchema.parse({
      ...defaultDesktopPreferences,
      ...preferenceStore.get("preferences"),
    });
  });
  ipcMain.handle(ipcChannels.savePreferences, (event, candidate: unknown) => {
    assertMainWindow(event.sender);
    const patch = DesktopPreferencesPatchSchema.parse(candidate);
    const current = DesktopPreferencesSchema.parse({
      ...defaultDesktopPreferences,
      ...preferenceStore.get("preferences"),
    });
    const next = DesktopPreferencesSchema.parse({
      ...current,
      ...patch,
    });
    if (current.voiceShortcutEnabled !== next.voiceShortcutEnabled || current.microphoneAllowed !== next.microphoneAllowed) {
      globalShortcut.unregister("CommandOrControl+Shift+Space");
      if (next.voiceShortcutEnabled && next.microphoneAllowed) {
        const registered = globalShortcut.register("CommandOrControl+Shift+Space", () => {
          mainWindow?.webContents.send(ipcChannels.voiceShortcut);
        });
        if (!registered) next.voiceShortcutEnabled = false;
      } else {
        next.voiceShortcutEnabled = false;
      }
    }
    preferenceStore.set("preferences", next);
    return next;
  });
  ipcMain.handle(ipcChannels.openExternal, (event, candidate: unknown) => {
    assertMainWindow(event.sender);
    return openApprovedExternalUrl(candidate);
  });
  ipcMain.on(ipcChannels.minimizeWindow, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window !== mainWindow) return;
    window?.minimize();
  });
  ipcMain.on(ipcChannels.toggleMaximizeWindow, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window !== mainWindow) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.on(ipcChannels.closeWindow, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && window === mainWindow) window.close();
  });
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: "#07111c",
    title: displayName(),
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(currentDirectory, "../preload/preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("maximize", () => mainWindow?.webContents.send(ipcChannels.maximizedChange, true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send(ipcChannels.maximizedChange, false));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openApprovedExternalUrl(url).catch(() => undefined);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (isInternalNavigation(target)) return;
    event.preventDefault();
    void openApprovedExternalUrl(target).catch(() => undefined);
  });

  if (app.isPackaged) {
    void mainWindow.loadFile(join(currentDirectory, "../renderer/index.html"));
  } else {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (!rendererUrl) throw new Error("The Electron renderer URL was not provided by Vite.");
    void mainWindow.loadURL(rendererUrl);
  }
}

app.whenReady().then(() => {
  const backend = new URL(backendBaseUrl());
  const websocketOrigin = `${backend.protocol === "https:" ? "wss:" : "ws:"}//${backend.host}`;
  const developmentOrigins = app.isPackaged
    ? ""
    : " http://127.0.0.1:5173 http://localhost:5173 ws://127.0.0.1:5173 ws://localhost:5173";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; font-src 'self' data:; " +
            `connect-src 'self' ${backend.origin} ${websocketOrigin}${developmentOrigins}; ` +
            "object-src 'none'; base-uri 'self'; frame-src 'none'",
        ],
      },
    });
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== "media" || !mainWindow || webContents !== mainWindow.webContents) {
      callback(false);
      return;
    }
    const preferences = DesktopPreferencesSchema.parse({
      ...defaultDesktopPreferences,
      ...preferenceStore.get("preferences"),
    });
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
    const audioOnly = mediaTypes?.length === 1 && mediaTypes[0] === "audio";
    callback(preferences.microphoneAllowed && audioOnly);
  });
  registerIpcHandlers();
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  globalShortcut.unregisterAll();
  if (process.platform !== "darwin") app.quit();
});