import { describe, expect, it } from "vitest";
import { browserCapabilityMatrix } from "@/services/deployment";
import { buildInitialValidationChecks, statusFromCapability, validationExport } from "@/services/managed-validation";

 describe("managed device validation", () => {
  it("presents all 22 capabilities with an allowed explicit status", () => {
    const checks = buildInitialValidationChecks(browserCapabilityMatrix());
    expect(checks).toHaveLength(22);
    expect(checks.every((check) => ["PASS", "FAIL", "BLOCKED BY POLICY", "UNCONFIGURED", "UNSUPPORTED", "NOT TESTED"].includes(check.status))).toBe(true);
    expect(checks.find((check) => check.id === "stt_provider")?.status).toBe("NOT TESTED");
  });

  it("maps capability statuses without implying policy when unavailable is unknown", () => {
    expect(statusFromCapability("blocked_by_policy")).toBe("BLOCKED BY POLICY");
    expect(statusFromCapability("unsupported")).toBe("UNSUPPORTED");
    expect(statusFromCapability("unconfigured")).toBe("UNCONFIGURED");
    expect(statusFromCapability("unavailable")).toBe("FAIL");
  });

  it("exports only fixed check fields and excludes diagnostic secrets", () => {
    const checks = [
      { id: "voice_input", label: "private transcript", status: "NOT TESTED" as const, detail: "private arguments", token: "secret" },
      { id: "unknown", label: "secret", status: "PASS" as const, detail: "private path" },
    ];
    const json = validationExport(checks, "json", "2026-10-08T12:00:00.000Z");
    const text = validationExport(checks, "text", "2026-10-08T12:00:00.000Z");
    expect(json).toContain("NOT TESTED");
    expect(json).not.toContain("private");
    expect(json).not.toContain("secret");
    expect(text).not.toContain("private");
  });
});
