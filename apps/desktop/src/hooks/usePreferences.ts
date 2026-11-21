import { useEffect, useState } from "react";
import type { DesktopPreferences, DesktopPreferencesPatch } from "../../electron/contracts";
import { useAppStore } from "@/state/app-store";
import { loadBrowserPreferences, saveBrowserPreferences } from "@/services/browser-preferences";

export function usePreferences() {
  const preferences = useAppStore((state) => state.preferences);
  const loaded = useAppStore((state) => state.preferencesLoaded);
  const setPreferences = useAppStore((state) => state.setPreferences);
  const setLoaded = useAppStore((state) => state.setPreferencesLoaded);

  useEffect(() => {
    let active = true;
    if (!window.jarvis) {
      setPreferences(loadBrowserPreferences());
      setLoaded(true);
      return () => { active = false; };
    }
    void window.jarvis.getPreferences().then((value) => {
      if (!active) return;
      setPreferences(value);
      setLoaded(true);
    }).catch(() => setLoaded(true));
    return () => { active = false; };
  }, []);

  async function updatePreferences(patch: DesktopPreferencesPatch) {
    if (window.jarvis) {
      const saved = await window.jarvis.savePreferences(patch);
      setPreferences(saved);
      return;
    }
    const updated = { ...preferences, ...patch };
    saveBrowserPreferences(updated);
    setPreferences(updated);
  }

  return { preferences, updatePreferences, loaded };
}