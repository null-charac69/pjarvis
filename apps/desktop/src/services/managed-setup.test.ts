import { describe, expect, it } from "vitest";
import { browserCapabilityMatrix } from "@/services/deployment";
import {
  buildInitialValidationChecks,
  EMPTY_SETUP_PROGRESS,
  loadSetupProgress,
  providerStatusForCheck,
  readinessStatus,
  requirementForCheck,
  saveSetupProgress,
  VALIDATION_STATUSES,
  WIZARD_STEPS,
  type BrowserSetupProgress,
} from "@/services/managed-setup";

describe("managed setup wizard model", () => {
  it("keeps the ordered progressive flow and all 22 validation checks", () => {
    expect(WIZARD_STEPS).toHaveLength(18);
    expect(WIZARD_STEPS.map((step) => step.title)).toEqual([
      "Browser and backend", "Data directory", "Language model", "Speech-to-text provider",
      "Speech output", "Web search", "Weather location", "Workspace folders", "Git repository",
      "Applications and websites", "Notifications", "Memory and retention", "Permissions and confirmations",
      "Microphone and audio input", "Wake mode and shortcut", "Live service tests",
      "End-to-end voice command", "Final readiness report",
    ]);
    expect(buildInitialValidationChecks(browserCapabilityMatrix())).toHaveLength(22);
  });

  it("does not mark feature detection as successful validation", () => {
    const checks = buildInitialValidationChecks(browserCapabilityMatrix());
    expect(checks.filter((check) => check.status === "PASS")).toHaveLength(0);
    expect(VALIDATION_STATUSES).toContain("REQUIRES_CREDENTIALS");
  });

  it("classifies the active provider without treating an alternate LLM as required", () => {
    expect(providerStatusForCheck("local_llm", "local", "healthy")).toBe("NOT_TESTED");
    expect(providerStatusForCheck("external_llm", "local", "healthy")).toBe("UNCONFIGURED");
    expect(providerStatusForCheck("stt_provider", "unconfigured", "unconfigured")).toBe("REQUIRES_CREDENTIALS");
    expect(providerStatusForCheck("stt_provider", "mock", "healthy")).toBe("DEGRADED");
    expect(requirementForCheck("weather")).toBe("optional");
    expect(requirementForCheck("system_tray")).toBe("electron_only");
  });

  it("requires core voice readiness while treating optional and Electron-only checks as limitations", () => {
    const checks = buildInitialValidationChecks(browserCapabilityMatrix()).map((check) => ({
      ...check,
      status: ["voice_input", "push_to_talk", "local_llm", "stt_provider", "tts"].includes(check.id)
        ? "PASS" as const
        : check.status,
    }));
    expect(readinessStatus(checks, "healthy", "connected", "local")).toBe("READY_WITH_LIMITATIONS");

    const missingSpeech = checks.map((check) => check.id === "stt_provider" ? { ...check, status: "REQUIRES_CREDENTIALS" as const } : check);
    expect(readinessStatus(missingSpeech, "healthy", "connected", "local")).toBe("CONFIGURATION_REQUIRED");

    const optionalPolicyBlock = checks.map((check) => check.id === "weather" ? { ...check, status: "BLOCKED_BY_POLICY" as const } : check);
    expect(readinessStatus(optionalPolicyBlock, "healthy", "connected", "local")).toBe("READY_WITH_LIMITATIONS");

    const externalProvider = checks.map((check) => {
      if (check.id === "local_llm") return { ...check, status: "UNCONFIGURED" as const };
      if (check.id === "external_llm") return { ...check, status: "PASS" as const };
      return check;
    });
    expect(readinessStatus(externalProvider, "healthy", "connected", "external")).toBe("READY_WITH_LIMITATIONS");

    const requiredPolicyBlock = checks.map((check) => check.id === "stt_provider" ? { ...check, status: "BLOCKED_BY_POLICY" as const } : check);
    expect(readinessStatus(requiredPolicyBlock, "healthy", "connected", "local")).toBe("BLOCKED_BY_POLICY");

    const restartPending = checks.map((check) => check.requirement === "required" ? { ...check, status: "REQUIRES_RESTART" as const } : check);
    expect(readinessStatus(restartPending, "healthy", "connected", "local")).toBe("CONFIGURATION_REQUIRED");
  });

  it("resumes the step and evidence but drops secret-like and unknown fields", () => {
    const storage = window.localStorage;
    const progress = structuredClone(EMPTY_SETUP_PROGRESS) as BrowserSetupProgress & Record<string, unknown>;
    progress.stepIndex = 5;
    progress.evidence = {
      backend_connection: {
        status: "PASS",
        testedAt: "2026-10-08T12:00:00.000Z",
        code: "backend_health",
        token: "must-not-persist",
      } as BrowserSetupProgress["evidence"][string],
    };
    progress.preferences = {
      ...progress.preferences,
      apiKey: "must-not-persist-either",
    } as BrowserSetupProgress["preferences"];
    progress.apiKey = "must-not-persist";

    saveSetupProgress(progress, storage);
    const stored = storage.getItem("jarvis.managedSetup.v1") ?? "";
    expect(stored).not.toContain("must-not-persist");
    const resumed = loadSetupProgress(storage);
    expect(resumed.stepIndex).toBe(5);
    expect(resumed.evidence.backend_connection).toEqual({
      status: "PASS",
      testedAt: "2026-10-08T12:00:00.000Z",
      code: "backend_health",
    });
    expect(resumed.preferences.audioRetention).toBe(false);
  });
});