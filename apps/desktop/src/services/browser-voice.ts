export const MAX_BROWSER_RECORDING_BYTES = 10 * 1024 * 1024;
export const BROWSER_SHORTCUT_OPTIONS = ["Ctrl+Space", "Ctrl+Shift+Space", "Alt+Shift+Space"] as const;
export type BrowserVoiceShortcut = typeof BROWSER_SHORTCUT_OPTIONS[number];

export type BrowserShortcutPreferences = {
  enabled: boolean;
  shortcut: BrowserVoiceShortcut;
};

const SHORTCUT_STORAGE_KEY = "jarvis.browserVoiceShortcut";
const DEFAULT_SHORTCUT_PREFERENCES: BrowserShortcutPreferences = {
  enabled: true,
  shortcut: "Ctrl+Space",
};

export function supportedRecorderMimeType(
  recorder: Pick<typeof MediaRecorder, "isTypeSupported"> | undefined = globalThis.MediaRecorder,
): string | null {
  if (!recorder) return null;
  return ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]
    .find((mimeType) => recorder.isTypeSupported(mimeType)) ?? null;
}

export function validateBrowserRecording(blob: Blob, maxBytes = MAX_BROWSER_RECORDING_BYTES): string | null {
  if (blob.size === 0) return "The recording is empty.";
  if (blob.size > maxBytes) return "The recording exceeded the allowed size.";
  const contentType = blob.type.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType || !["audio/webm", "audio/ogg", "audio/mp4"].includes(contentType)) {
    return "This browser produced an unsupported audio format.";
  }
  return null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"));
}

export function matchesBrowserVoiceShortcut(event: KeyboardEvent, shortcut: BrowserVoiceShortcut): boolean {
  if (event.code !== "Space" || event.metaKey || event.altKey && shortcut !== "Alt+Shift+Space") return false;
  if (shortcut === "Ctrl+Space") return event.ctrlKey && !event.shiftKey;
  if (shortcut === "Ctrl+Shift+Space") return event.ctrlKey && event.shiftKey;
  return event.altKey && event.shiftKey && !event.ctrlKey;
}

export function loadBrowserShortcutPreferences(): BrowserShortcutPreferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SHORTCUT_STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object") return { ...DEFAULT_SHORTCUT_PREFERENCES };
    const candidate = value as Partial<BrowserShortcutPreferences>;
    return {
      enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : DEFAULT_SHORTCUT_PREFERENCES.enabled,
      shortcut: BROWSER_SHORTCUT_OPTIONS.includes(candidate.shortcut as BrowserVoiceShortcut)
        ? candidate.shortcut as BrowserVoiceShortcut
        : DEFAULT_SHORTCUT_PREFERENCES.shortcut,
    };
  } catch {
    return { ...DEFAULT_SHORTCUT_PREFERENCES };
  }
}

export function saveBrowserShortcutPreferences(preferences: BrowserShortcutPreferences): void {
  try {
    const shortcut = BROWSER_SHORTCUT_OPTIONS.includes(preferences.shortcut)
      ? preferences.shortcut
      : DEFAULT_SHORTCUT_PREFERENCES.shortcut;
    localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify({ enabled: preferences.enabled, shortcut }));
  } catch {
    // Storage can be unavailable in managed or private browsing contexts.
  }
}

export type DirectoryPickerOutcome = "cancelled" | "not_allowed" | "blocked_or_unavailable";

export function directoryPickerSupported(picker: unknown): boolean {
  return typeof picker === "function";
}

export function directoryPickerOutcome(error: unknown): DirectoryPickerOutcome {
  if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
  if (error instanceof DOMException && error.name === "NotAllowedError") return "not_allowed";
  return "blocked_or_unavailable";
}
