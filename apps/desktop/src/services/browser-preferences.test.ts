import { describe, expect, it } from "vitest";
import { defaultDesktopPreferences } from "../../electron/contracts";
import { loadBrowserPreferences, saveBrowserPreferences } from "@/services/browser-preferences";

describe("browser preferences", () => {
  it("persists only strict non-secret application preferences", () => {
    const storage = window.localStorage;
    const preferences = { ...defaultDesktopPreferences, voiceOutputVoiceURI: "local-en", voiceOutputEnabled: true };
    saveBrowserPreferences(preferences, storage);
    expect(loadBrowserPreferences(storage)).toMatchObject({ voiceOutputVoiceURI: "local-en", voiceOutputEnabled: true });
    expect(storage.getItem("jarvis.browserPreferences.v1")).not.toContain("apiKey");
  });

  it("discards unknown secret-like fields when resuming", () => {
    const storage = window.localStorage;
    storage.setItem("jarvis.browserPreferences.v1", JSON.stringify({ theme: "light", apiKey: "must-not-load" }));
    expect(loadBrowserPreferences(storage)).toMatchObject({ theme: "light", voiceOutputEnabled: false });
    expect(JSON.stringify(loadBrowserPreferences(storage))).not.toContain("must-not-load");
  });
});