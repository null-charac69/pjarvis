import { afterEach, describe, expect, it, vi } from "vitest";
import { PWA_INSTALL_UNDETERMINED_MESSAGE, pwaInstallAvailability } from "@/services/deployment";

describe("PWA install availability", () => {
  afterEach(() => {
    delete window.__jarvisInstallPrompt;
    vi.restoreAllMocks();
  });

  it("reports installed only for standalone display mode", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    expect(pwaInstallAvailability()).toBe("installed");
  });

  it("reports an offered prompt only when the browser explicitly supplies one", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    window.__jarvisInstallPrompt = { prompt: vi.fn(), userChoice: Promise.resolve({ outcome: "dismissed", platform: "" }) } as unknown as NonNullable<Window["__jarvisInstallPrompt"]>;
    expect(pwaInstallAvailability()).toBe("available");
  });

  it("uses neutral wording when install availability is not offered or determinable", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    expect(pwaInstallAvailability()).toBe("unavailable_or_not_offered");
    expect(PWA_INSTALL_UNDETERMINED_MESSAGE).toBe("PWA installation unavailable or not offered by this browser configuration.");
  });
});
