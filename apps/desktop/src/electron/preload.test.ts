import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultDesktopPreferences, ipcChannels, type DesktopBridge } from "../../electron/contracts";

const ipcMocks = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: ipcMocks.expose },
  ipcRenderer: {
    invoke: ipcMocks.invoke,
    send: ipcMocks.send,
    on: ipcMocks.on,
    removeListener: ipcMocks.removeListener,
  },
}));

describe("Electron preload bridge", () => {
  let bridge: DesktopBridge;

  beforeEach(async () => {
    vi.resetModules();
    ipcMocks.expose.mockClear();
    ipcMocks.invoke.mockReset();
    ipcMocks.send.mockReset();
    ipcMocks.on.mockReset();
    ipcMocks.removeListener.mockReset();
    await import("../../electron/preload");
    bridge = ipcMocks.expose.mock.calls.at(-1)?.[1] as DesktopBridge;
  });

  it("exposes only the reviewed bridge methods and fixed IPC channels", () => {
    expect(bridge.isElectron).toBe(true);
    expect(Object.keys(bridge).sort()).toEqual([
      "closeWindow", "getBackendBaseUrl", "getPreferences", "isElectron",
      "minimizeWindow", "onMaximizedChange", "onVoiceShortcut", "openExternal",
      "savePreferences", "toggleMaximizeWindow",
    ]);
    expect(ipcMocks.expose).toHaveBeenCalledWith("jarvis", bridge);
  });

  it("validates preference patches and external URLs before invoking IPC", async () => {
    ipcMocks.invoke.mockResolvedValue(defaultDesktopPreferences);
    await expect((bridge.savePreferences as (value: unknown) => Promise<unknown>)({ unexpected: true })).rejects.toThrow();
    await expect(bridge.openExternal("javascript:alert(1)")).rejects.toThrow();
    expect(ipcMocks.invoke).not.toHaveBeenCalled();

    await bridge.savePreferences({ theme: "light" });
    await bridge.openExternal("https://example.com/docs");
    expect(ipcMocks.invoke).toHaveBeenNthCalledWith(1, ipcChannels.savePreferences, { theme: "light" });
    expect(ipcMocks.invoke).toHaveBeenNthCalledWith(2, ipcChannels.openExternal, "https://example.com/docs");
  });

  it("forwards only fixed window-control channels and removes maximized listeners", () => {
    bridge.minimizeWindow();
    bridge.toggleMaximizeWindow();
    bridge.closeWindow();
    expect(ipcMocks.send.mock.calls).toEqual([
      [ipcChannels.minimizeWindow],
      [ipcChannels.toggleMaximizeWindow],
      [ipcChannels.closeWindow],
    ]);

    const callback = vi.fn();
    const dispose = bridge.onMaximizedChange(callback);
    const [, listener] = ipcMocks.on.mock.calls[0];
    listener({}, true);
    listener({}, "invalid");
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(true);
    dispose();
    expect(ipcMocks.removeListener).toHaveBeenCalledWith(ipcChannels.maximizedChange, listener);
  });

  it("forwards and removes the fixed voice shortcut callback", () => {
    const callback = vi.fn();
    const dispose = bridge.onVoiceShortcut(callback);
    const [channel, listener] = ipcMocks.on.mock.calls.at(-1)!;
    expect(channel).toBe(ipcChannels.voiceShortcut);
    listener();
    expect(callback).toHaveBeenCalledOnce();
    dispose();
    expect(ipcMocks.removeListener).toHaveBeenCalledWith(ipcChannels.voiceShortcut, listener);
  });
});