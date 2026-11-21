import { browserCapabilityMatrix, type SystemCapability } from "@/services/deployment";

export const VALIDATION_STATUSES = [
  "PASS",
  "FAIL",
  "BLOCKED BY POLICY",
  "UNCONFIGURED",
  "UNSUPPORTED",
  "NOT TESTED",
] as const;

export type ValidationStatus = typeof VALIDATION_STATUSES[number];
export type ValidationCheck = { id: string; label: string; status: ValidationStatus; detail: string };

export function statusFromCapability(status: SystemCapability["status"]): ValidationStatus {
  switch (status) {
    case "available": return "PASS";
    case "unavailable":
    case "degraded": return "FAIL";
    case "blocked_by_policy": return "BLOCKED BY POLICY";
    case "unsupported": return "UNSUPPORTED";
    case "unconfigured": return "UNCONFIGURED";
  }
}

export function buildInitialValidationChecks(capabilities: SystemCapability[]): ValidationCheck[] {
  return capabilities.map(({ id, label, status, detail }) => ({
    id,
    label,
    status: ["voice_input", "push_to_talk", "tts", "notifications", "stt_provider", "tts_provider"].includes(id)
      ? status === "unsupported" ? "UNSUPPORTED" : "NOT TESTED"
      : statusFromCapability(status),
    detail,
  }));
}

export function validationExport(checks: ValidationCheck[], format: "json" | "text", generatedAt = new Date().toISOString()): string {
  const canonical = new Map(browserCapabilityMatrix().map(({ id, label, detail }) => [id, { id, label, detail }]));
  const safeChecks = checks.flatMap(({ id, status }) => {
    const approved = canonical.get(id);
    if (!approved || !VALIDATION_STATUSES.includes(status)) return [];
    return [{ ...approved, status }];
  });
  const timestamp = Number.isFinite(Date.parse(generatedAt)) ? new Date(generatedAt).toISOString() : new Date(0).toISOString();
  if (format === "json") return JSON.stringify({ generatedAt: timestamp, checks: safeChecks }, null, 2);
  return [
    `JARVIS managed-device validation (${timestamp})`,
    ...safeChecks.map((check) => `${check.status}: ${check.label} - ${check.detail}`),
  ].join("\n");
}
