import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultDesktopPreferences, ipcChannels } from "../../electron/contracts";

const mainMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  listeners: new Map<string, (...args: any[]) => unknown>(),
  webContentsListeners: new Map<string, (...args: any[]) => unknown>(),
  appListeners: new Map<string, (...args: any[]) => unknown>(),
  openExternal: vi.fn(async () => undefined),
  registerShortcut: vi.fn(() => true),
  unregisterShortcut: vi.fn(),
  unregisterAllShortcuts: vi.fn(),
  onHeadersReceived: vi.fn(),
  permissionRequestHandler: undefined as undefined | ((webContents: unknown, permission: string, callback: (allowed: boolean) => void, details: unknown) => void),
  windowOpenHandler: undefined as undefined | ((details: { url: string }) => { action: string }),
  window: undefined as any,
  options: undefined as any,
}));

vi.mock("electron", () => {
  class BrowserWindowMock {
    webContents = {
      send: vi.fn(),
      setWindowOpenHandler: vi.fn((handler) => { mainMocks.windowOpenHandler = handler; }),
      on: vi.fn((name, listener) => { mainMocks.webContentsListeners.set(name, listener); }),
    };
    once = vi.fn((name, callback) => { if (name === "ready-to-show") callback(); });
    on = vi.fn();
    show = vi.fn();
    loadURL = vi.fn(async () => undefined);
    loadFile = vi.fn(async () => undefined);
    minimize = vi.fn();
    close = vi.fn();
    maximize = vi.fn();
    unmaximize = vi.fn();
    isMaximized = vi.fn(() => false);

    constructor(options: unknown) {
      mainMocks.window = this;
      mainMocks.options = options;
    }
  }

  return {
    app: {
      isPackaged: false,
      whenReady: () => Promise.resolve(),
      on: vi.fn((name, listener) => { mainMocks.appListeners.set(name, listener); }),
      quit: vi.fn(),
    },
    BrowserWindow: Object.assign(BrowserWindowMock, {
      fromWebContents: vi.fn((sender) => sender === mainMocks.window?.webContents ? mainMocks.window : null),
      getAllWindows: vi.fn(() => [mainMocks.window]),
    }),
    ipcMain: {
      handle: vi.fn((channel, handler) => { mainMocks.handlers.set(channel, handler); }),
      on: vi.fn((channel, listener) => { mainMocks.listeners.set(channel, listener); }),
    },
    shell: { openExternal: mainMocks.openExternal },
    globalShortcut: {
      register: mainMocks.registerShortcut,
      unregister: mainMocks.unregisterShortcut,
      unregisterAll: mainMocks.unregisterAllShortcuts,
    },
    session: { defaultSession: {
      webRequest: { onHeadersReceived: mainMocks.onHeadersReceived },
      setPermissionRequestHandler: vi.fn((handler) => { mainMocks.permissionRequestHandler = handler; }),
    } },
  };
});

vi.mock("electron-store", () => ({
  default: class MockStore {
    values: Record<string, unknown>;
    constructor(options: { defaults: Record<string, unknown> }) { this.values = { ...options.defaults }; }
    get(key: string) { return this.values[key]; }
    set(key: string, value: unknown) { this.values[key] = value; }
  },
}));

async function startMainProcess() {
  vi.resetModules();
  mainMocks.handlers.clear();
  mainMocks.listeners.clear();
  mainMocks.webContentsListeners.clear();
  mainMocks.appListeners.clear();
  mainMocks.windowOpenHandler = undefined;
  mainMocks.window = undefined;
  mainMocks.options = undefined;
  mainMocks.openExternal.mockClear();
  mainMocks.onHeadersReceived.mockClear();
  mainMocks.registerShortcut.mockClear();
  mainMocks.unregisterShortcut.mockClear();
  mainMocks.unregisterAllShortcuts.mockClear();
  mainMocks.permissionRequestHandler = undefined;
  vi.stubEnv("ELECTRON_RENDERER_URL", "http://127.0.0.1:5173");
  vi.stubEnv("JARVIS_BACKEND_URL", "http://localhost:8765");
  await import("../../electron/main");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Electron main-process IPC and navigation policy", () => {
  beforeEach(startMainProcess);
  afterEach(() => vi.unstubAllEnvs());

  it("configures renderer isolation, sandbox, security headers, and only reviewed handlers", () => {
    expect(mainMocks.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
    expect([...mainMocks.handlers.keys()]).toEqual([
      ipcChannels.getBackendBaseUrl,
      ipcChannels.getPreferences,
      ipcChannels.savePreferences,
      ipcChannels.openExternal,
    ]);
    expect([...mainMocks.listeners.keys()]).toEqual([
      ipcChannels.minimizeWindow,
      ipcChannels.toggleMaximizeWindow,
      ipcChannels.closeWindow,
    ]);
    expect(mainMocks.onHeadersReceived).toHaveBeenCalledOnce();
  });

  it("validates main-process sender and preference payloads", async () => {
    const event = { sender: mainMocks.window.webContents };
    const getBackend = mainMocks.handlers.get(ipcChannels.getBackendBaseUrl)!;
    const getPreferences = mainMocks.handlers.get(ipcChannels.getPreferences)!;
    const savePreferences = mainMocks.handlers.get(ipcChannels.savePreferences)!;

    expect(getBackend(event)).toBe("http://localhost:8765");
    expect(getPreferences(event)).toEqual(defaultDesktopPreferences);
    expect(() => getPreferences({ sender: {} })).toThrow(/application window/);
    expect(() => savePreferences(event, { fontScale: 3 })).toThrow();
    expect(() => savePreferences(event, { unexpected: true })).toThrow();
    expect(savePreferences(event, { theme: "light" })).toMatchObject({ theme: "light" });
  });

  it("requires HTTPS for remote backends while allowing loopback HTTP", async () => {
    const { backendBaseUrl } = await import("../../electron/main");

    vi.stubEnv("JARVIS_BACKEND_URL", "http://127.0.0.1:9000/api");
    expect(backendBaseUrl()).toBe("http://127.0.0.1:9000");
    vi.stubEnv("JARVIS_BACKEND_URL", "https://api.example.com:9443/path");
    expect(backendBaseUrl()).toBe("https://api.example.com:9443");
    vi.stubEnv("JARVIS_BACKEND_URL", "http://api.example.com:9000");
    expect(() => backendBaseUrl()).toThrow(/must use HTTPS/);
  });

  it("trims, bounds, and defaults the desktop display name", async () => {
    const { displayName } = await import("../../electron/main");

    vi.stubEnv("JARVIS_DISPLAY_NAME", "  Jarvis Workstation  ");
    expect(displayName()).toBe("Jarvis Workstation");
    vi.stubEnv("JARVIS_DISPLAY_NAME", "x".repeat(80));
    expect(displayName()).toHaveLength(64);
    vi.stubEnv("JARVIS_DISPLAY_NAME", "  ");
    expect(displayName()).toBe("Local Assistant");
  });

  it("registers the global shortcut only after microphone consent and allows audio only", () => {
    const event = { sender: mainMocks.window.webContents };
    const savePreferences = mainMocks.handlers.get(ipcChannels.savePreferences)!;
    savePreferences(event, { microphoneAllowed: true, voiceShortcutEnabled: true });
    expect(mainMocks.registerShortcut).toHaveBeenCalledWith(
      "CommandOrControl+Shift+Space",
      expect.any(Function),
    );

    const permissionHandler = mainMocks.permissionRequestHandler!;
    const callback = vi.fn();
    permissionHandler(mainMocks.window.webContents, "media", callback, { mediaTypes: ["audio"] });
    expect(callback).toHaveBeenCalledWith(true);
    permissionHandler(mainMocks.window.webContents, "media", callback, { mediaTypes: ["audio", "video"] });
    expect(callback).toHaveBeenLastCalledWith(false);
  });

  it("denies unsafe external navigation and opens only credential-free HTTP(S) links", async () => {
    const policy = mainMocks.windowOpenHandler!;
    expect(policy({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
    expect(policy({ url: "https://user:secret@example.com" })).toEqual({ action: "deny" });
    expect(policy({ url: "https://example.com/docs" })).toEqual({ action: "deny" });

    const navigation = mainMocks.webContentsListeners.get("will-navigate")!;
    const preventDefault = vi.fn();
    navigation({ preventDefault }, "file:///tmp/other.html");
    expect(preventDefault).toHaveBeenCalledOnce();
    navigation({ preventDefault }, "http://127.0.0.1:5173/#/tasks");
    expect(preventDefault).toHaveBeenCalledOnce();

    await mainMocks.handlers.get(ipcChannels.openExternal)!({ sender: mainMocks.window.webContents }, "https://example.com/docs");
    expect(mainMocks.openExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("routes window controls only from the owning application window", () => {
    const sender = mainMocks.window.webContents;
    mainMocks.listeners.get(ipcChannels.minimizeWindow)!({ sender });
    mainMocks.listeners.get(ipcChannels.toggleMaximizeWindow)!({ sender });
    mainMocks.listeners.get(ipcChannels.closeWindow)!({ sender });
    expect(mainMocks.window.minimize).toHaveBeenCalledOnce();
    expect(mainMocks.window.maximize).toHaveBeenCalledOnce();
    expect(mainMocks.window.close).toHaveBeenCalledOnce();

    const other = { sender: {} };
    mainMocks.listeners.get(ipcChannels.closeWindow)!(other);
    expect(mainMocks.window.close).toHaveBeenCalledOnce();
  });
});