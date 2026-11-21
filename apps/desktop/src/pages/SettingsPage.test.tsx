import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/deployment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/deployment")>();
  return { ...actual, isBrowserDeployment: () => true, deploymentMode: () => "browser" };
});
vi.mock("@/hooks/useBackend", () => ({ useLlmHealth: () => ({ data: { status: "unconfigured" } }) }));
vi.mock("@/hooks/useTools", () => ({ useTools: () => ({ data: [] }) }));
vi.mock("@/services/api", () => ({ api: { voiceHealth: vi.fn() } }));
vi.mock("@/services/voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/voice")>();
  return { ...actual, enumerateAudioInputs: vi.fn(async () => []) };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { stt: { status: "unconfigured", message: "not configured" }, wakeWord: { status: "unconfigured", message: "not configured" } } }),
}));
vi.mock("@/hooks/usePreferences", () => ({
  usePreferences: () => ({
    loaded: true,
    updatePreferences: vi.fn(async () => undefined),
    preferences: {
      theme: "dark", accent: "cyan", density: "comfortable", fontScale: 1, reducedMotion: false,
      language: "en-US", timezone: "UTC", microphoneAllowed: false, microphoneDeviceId: "",
      wakeWordEnabled: false, voiceShortcutEnabled: false, voiceOutputEnabled: false,
      voiceOutputVoiceURI: "", voiceOutputVolume: 1, voiceOutputRate: 1, voiceSilenceMs: 1800,
      voiceMaxRecordingSeconds: 60, browserNotificationsEnabled: false, activityCollapsed: false,
      profileName: "User",
    },
  }),
}));

import { SettingsPage } from "@/pages/SettingsPage";

describe("Settings deployment navigation", () => {
  it("renders the validation action inside the visible browser Deployment section", () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "Deployment" })).toBeVisible();
    const link = screen.getByRole("link", { name: /Open Managed Device Validation/ });
    expect(link).toBeVisible();
    expect(link).toHaveAttribute("href", "/settings/deployment/validation");
  });
});
