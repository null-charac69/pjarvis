import { contextBridge, ipcRenderer } from "electron";
import {
  DesktopPreferencesPatchSchema,
  DesktopPreferencesSchema,
  ExternalUrlSchema,
  ipcChannels,
  type DesktopBridge,
} from "./contracts";

const bridge: DesktopBridge = {
  isElectron: true,
  getBackendBaseUrl: () => ipcRenderer.invoke(ipcChannels.getBackendBaseUrl),
  getPreferences: async () =>
    DesktopPreferencesSchema.parse(await ipcRenderer.invoke(ipcChannels.getPreferences)),
  savePreferences: async (patch) => {
    const validated = DesktopPreferencesPatchSchema.parse(patch);
    return DesktopPreferencesSchema.parse(
      await ipcRenderer.invoke(ipcChannels.savePreferences, validated),
    );
  },
  openExternal: async (url) => {
    const validated = ExternalUrlSchema.parse(url);
    return ipcRenderer.invoke(ipcChannels.openExternal, validated);
  },
  minimizeWindow: () => ipcRenderer.send(ipcChannels.minimizeWindow),
  toggleMaximizeWindow: () => ipcRenderer.send(ipcChannels.toggleMaximizeWindow),
  closeWindow: () => ipcRenderer.send(ipcChannels.closeWindow),
  onMaximizedChange: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (typeof value === "boolean") callback(value);
    };
    ipcRenderer.on(ipcChannels.maximizedChange, listener);
    return () => ipcRenderer.removeListener(ipcChannels.maximizedChange, listener);
  },
  onVoiceShortcut: (callback) => {
    const listener = () => callback();
    ipcRenderer.on(ipcChannels.voiceShortcut, listener);
    return () => ipcRenderer.removeListener(ipcChannels.voiceShortcut, listener);
  },
};

contextBridge.exposeInMainWorld("jarvis", bridge);