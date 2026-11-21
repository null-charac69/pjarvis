import { z } from "zod";

export const DesktopPreferencesSchema = z
  .object({
    theme: z.enum(["dark", "light", "system"]),
    accent: z.enum(["cyan", "blue", "amber"]),
    density: z.enum(["comfortable", "compact"]),
    reducedMotion: z.boolean(),
    fontScale: z.number().min(0.9).max(1.2),
    navigationCollapsed: z.boolean(),
    activityCollapsed: z.boolean(),
    language: z.string().min(2).max(32),
    timezone: z.string().min(1).max(64),
    profileName: z.string().min(1).max(64),
    microphoneAllowed: z.boolean(),
    microphoneDeviceId: z.string().max(512),
    voiceOutputEnabled: z.boolean(),
    voiceOutputVoiceURI: z.string().max(512),
    voiceOutputVolume: z.number().min(0).max(1),
    voiceOutputRate: z.number().min(0.5).max(2),
    voiceSilenceMs: z.number().int().min(500).max(5000),
    voiceMaxRecordingSeconds: z.number().int().min(5).max(120),
    browserNotificationsEnabled: z.boolean(),
    voiceShortcutEnabled: z.boolean(),
    wakeWordEnabled: z.boolean(),
    onboardingComplete: z.boolean(),
    onboardingStep: z.number().int().min(0).max(11),
  })
  .strict();

export const DesktopPreferencesPatchSchema = DesktopPreferencesSchema.partial().strict();

export type DesktopPreferences = z.infer<typeof DesktopPreferencesSchema>;
export type DesktopPreferencesPatch = z.infer<typeof DesktopPreferencesPatchSchema>;

export const defaultDesktopPreferences: DesktopPreferences = {
  theme: "dark",
  accent: "cyan",
  density: "comfortable",
  reducedMotion: false,
  fontScale: 1,
  navigationCollapsed: false,
  activityCollapsed: false,
  language: "en-IN",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  profileName: "Local operator",
  microphoneAllowed: false,
  microphoneDeviceId: "",
  voiceOutputEnabled: false,
  voiceOutputVoiceURI: "",
  voiceOutputVolume: 1,
  voiceOutputRate: 1,
  voiceSilenceMs: 1800,
  voiceMaxRecordingSeconds: 60,
  browserNotificationsEnabled: false,
  voiceShortcutEnabled: false,
  wakeWordEnabled: false,
  onboardingComplete: false,
  onboardingStep: 0,
};

export const ExternalUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  }, "Only credential-free HTTP or HTTPS links are allowed.");

export interface DesktopBridge {
  readonly isElectron: true;
  getBackendBaseUrl(): Promise<string>;
  getPreferences(): Promise<DesktopPreferences>;
  savePreferences(patch: DesktopPreferencesPatch): Promise<DesktopPreferences>;
  openExternal(url: string): Promise<boolean>;
  minimizeWindow(): void;
  toggleMaximizeWindow(): void;
  closeWindow(): void;
  onMaximizedChange(callback: (maximized: boolean) => void): () => void;
  onVoiceShortcut(callback: () => void): () => void;
}

export const ipcChannels = {
  getBackendBaseUrl: "desktop:get-backend-base-url",
  getPreferences: "desktop:get-preferences",
  savePreferences: "desktop:save-preferences",
  openExternal: "desktop:open-external",
  minimizeWindow: "window:minimize",
  toggleMaximizeWindow: "window:toggle-maximize",
  closeWindow: "window:close",
  maximizedChange: "window:maximized",
  voiceShortcut: "voice:shortcut",
} as const;