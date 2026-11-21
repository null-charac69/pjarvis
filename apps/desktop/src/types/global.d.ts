import type { DesktopBridge } from "../../electron/contracts";

declare global {
  interface Window {
    jarvis?: DesktopBridge;
  }
}

export {};