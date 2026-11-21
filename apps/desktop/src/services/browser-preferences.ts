import { DesktopPreferencesSchema, defaultDesktopPreferences, type DesktopPreferences } from "../../electron/contracts";

const STORAGE_KEY = "jarvis.browserPreferences.v1";

export function loadBrowserPreferences(storage: Pick<Storage, "getItem"> = localStorage): DesktopPreferences {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaultDesktopPreferences };
    const candidate: unknown = JSON.parse(raw);
    if (!candidate || typeof candidate !== "object") return { ...defaultDesktopPreferences };
    const allowed = new Set(Object.keys(defaultDesktopPreferences));
    const safeValues = Object.fromEntries(Object.entries(candidate).filter(([key]) => allowed.has(key)));
    const parsed = DesktopPreferencesSchema.safeParse({ ...defaultDesktopPreferences, ...safeValues });
    return parsed.success ? parsed.data : { ...defaultDesktopPreferences };
  } catch {
    return { ...defaultDesktopPreferences };
  }
}

export function saveBrowserPreferences(preferences: DesktopPreferences, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    const safePreferences = DesktopPreferencesSchema.parse(preferences);
    storage.setItem(STORAGE_KEY, JSON.stringify(safePreferences));
  } catch {
    // Private or managed browser storage may be unavailable.
  }
}