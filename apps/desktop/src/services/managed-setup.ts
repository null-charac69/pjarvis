import { browserCapabilityMatrix, type SystemCapability } from "@/services/deployment";

export const VALIDATION_STATUSES = [
  "PASS",
  "FAILED",
  "UNCONFIGURED",
  "BLOCKED_BY_POLICY",
  "UNSUPPORTED",
  "DEGRADED",
  "NOT_TESTED",
  "REQUIRES_USER_ACTION",
  "REQUIRES_CREDENTIALS",
  "REQUIRES_MODEL",
  "REQUIRES_RESTART",
] as const;

export type ValidationStatus = typeof VALIDATION_STATUSES[number];
export type CheckRequirement = "required" | "optional" | "electron_only";
export type RuntimeProviderKind = "local" | "external" | "mock" | "unconfigured";
export type ValidationCheck = {
  id: string;
  label: string;
  status: ValidationStatus;
  detail: string;
  requirement: CheckRequirement;
};

export const WIZARD_STEPS = [
  { id: "connection", title: "Browser and backend", summary: "Verify this browser profile, loopback API, and authenticated event stream.", checks: ["voice_input", "push_to_talk"] },
  { id: "data", title: "Data directory", summary: "Review the user-writable data location. Changing it requires a user-level restart.", checks: ["workspace_tools"] },
  { id: "llm", title: "Language model", summary: "Choose a supported local or hosted language model and validate it before saving.", checks: ["local_llm", "external_llm"] },
  { id: "stt", title: "Speech-to-text provider", summary: "Use a real backend transcription test. Provider selection and model paths are backend-owned.", checks: ["stt_provider"] },
  { id: "tts", title: "Speech output", summary: "Choose supported browser-local speech preferences and test actual playback.", checks: ["tts", "tts_provider"] },
  { id: "search", title: "Web search", summary: "Choose the supported search provider; credentials stay in the backend environment.", checks: ["web_search"] },
  { id: "weather", title: "Weather location", summary: "Set a default location and units, then explicitly run a live lookup.", checks: ["weather"] },
  { id: "workspace", title: "Workspace folders", summary: "Add explicit backend-approved roots and constrain readable file types and size.", checks: ["workspace_tools"] },
  { id: "git", title: "Git repository", summary: "Select a repository by adding its directory as an approved workspace root.", checks: ["git_read"] },
  { id: "applications", title: "Applications and websites", summary: "Review explicit website origins and executable paths; each remains permission-gated.", checks: ["application_launch", "webpage_retrieval"] },
  { id: "notifications", title: "Notifications", summary: "Request browser permission only after you activate the control.", checks: ["notifications"] },
  { id: "retention", title: "Memory and retention", summary: "Review user-level retention boundaries. Raw-audio retention remains disabled by default.", checks: ["workspace_tools"] },
  { id: "permissions", title: "Permissions and confirmations", summary: "Review current grants and audit records without creating or approving a grant.", checks: ["workspace_tools", "git_read"] },
  { id: "microphone", title: "Microphone and audio input", summary: "Check permission state and capture a short local audio sample only after you start the test.", checks: ["voice_input"] },
  { id: "wake", title: "Wake mode and shortcut", summary: "Configure page-focused push-to-talk; browser wake listening cannot continue after the page closes.", checks: ["wake_word", "push_to_talk", "global_shortcut"] },
  { id: "live-tests", title: "Live service tests", summary: "Run real weather, search, and approved-page checks only when you activate each test.", checks: ["web_search", "weather", "webpage_retrieval"] },
  { id: "voice-command", title: "End-to-end voice command", summary: "Use the existing push-to-talk command path; this wizard never fabricates a transcript or tool result.", checks: ["voice_input", "stt_provider", "local_llm", "tts"] },
  { id: "readiness", title: "Final readiness report", summary: "Review observed evidence, exact limitations, and the next action for each capability.", checks: [] },
] as const;

export type WizardStepId = typeof WIZARD_STEPS[number]["id"];
export type EvidenceCode = "backend_health" | "microphone_capture" | "stt_transcription" | "local_tts" | "provider_health" | "tool_health" | "notification_delivery" | "grant_audit_read";
export type ValidationEvidence = { status: ValidationStatus; testedAt: string; code: EvidenceCode };
export type BrowserSetupPreferences = {
  language: string;
  timezone: string;
  voiceURI: string;
  speechRate: number;
  speechVolume: number;
  audioRetention: false;
};
export type BrowserSetupProgress = {
  stepIndex: number;
  skippedSteps: WizardStepId[];
  evidence: Record<string, ValidationEvidence>;
  preferences: BrowserSetupPreferences;
};

const STORAGE_KEY = "jarvis.managedSetup.v1";
const STEP_IDS = new Set<string>(WIZARD_STEPS.map((step) => step.id));
const EVIDENCE_CODES = new Set<EvidenceCode>([
  "backend_health", "microphone_capture", "stt_transcription", "local_tts",
  "provider_health", "tool_health", "notification_delivery", "grant_audit_read",
]);
const CHECK_IDS = new Set([
  "voice_input", "push_to_talk", "wake_word", "tts", "web_search", "weather",
  "webpage_retrieval", "workspace_tools", "git_read", "application_launch", "clipboard",
  "screenshots", "notifications", "global_shortcut", "system_tray", "window_controls",
  "background_automation", "scheduled_tasks", "local_llm", "external_llm", "stt_provider",
  "tts_provider", "backend_connection", "websocket_connection", "data_directory", "permissions_audit",
]);

export const EMPTY_SETUP_PROGRESS: BrowserSetupProgress = {
  stepIndex: 0,
  skippedSteps: [],
  evidence: {},
  preferences: {
    language: "en-IN",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    voiceURI: "",
    speechRate: 1,
    speechVolume: 1,
    audioRetention: false,
  },
};

export type CheckGuidance = {
  why: string;
  missing: string;
  permissions: string;
  admin: "No" | "Not detected; do not elevate" | "Not applicable in browser";
  policy: string;
  credentials: string;
  model: string;
  troubleshooting: string;
};

const PROVIDER_CHECKS = new Set(["local_llm", "external_llm", "stt_provider", "web_search"]);
const ELECTRON_ONLY_CHECKS = new Set([
  "application_launch", "clipboard", "screenshots", "global_shortcut", "system_tray",
  "window_controls", "background_automation", "scheduled_tasks",
]);
const REQUIRED_CHECKS = new Set(["voice_input", "push_to_talk", "local_llm", "external_llm", "stt_provider", "tts"]);

function validTimeZone(value: string): boolean {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function guidanceForCheck(check: Pick<ValidationCheck, "id" | "label" | "detail">): CheckGuidance {
  const unsupported = ELECTRON_ONLY_CHECKS.has(check.id);
  const provider = PROVIDER_CHECKS.has(check.id);
  const requiresUser = ["voice_input", "push_to_talk", "tts", "notifications"].includes(check.id);
  return {
    why: check.detail,
    missing: unsupported
      ? "This capability is outside the browser security/runtime model."
      : provider ? "A healthy, explicitly configured backend provider and any required user-supplied configuration." : requiresUser ? "A successful user-initiated browser test; feature detection alone is not validation." : "A successful live backend/tool test and any operator-approved configuration.",
    permissions: check.id === "voice_input" || check.id === "push_to_talk" ? "Microphone permission, requested only after your action." : check.id === "notifications" ? "Browser notification permission, requested only after your action." : "No additional browser permission is requested by diagnostics.",
    admin: unsupported ? "Not applicable in browser" : "No",
    policy: unsupported ? "Not applicable in browser." : "Organization browser, endpoint, network, and provider policies may restrict this capability; JARVIS will not change them.",
    credentials: check.id === "web_search" || check.id === "external_llm" ? "Backend-managed provider credentials may be required. Never paste secrets here." : "No credential is collected by this wizard.",
    model: check.id === "local_llm" || check.id === "stt_provider" || check.id === "wake_word" ? "A configured local model may be required; no model is downloaded or machine-scanned." : "No model file is requested by this wizard.",
    troubleshooting: unsupported
      ? "Use the browser-supported alternative: focused push-to-talk, browser-local speech, and in-app notifications."
      : provider ? "Ask the backend operator to configure the approved provider through the existing environment/profile settings, then restart only the owned JARVIS profile and retest." : "Refresh the live check. If policy denies the requested browser permission, use the in-app alternative or contact the device administrator; do not bypass policy.",
  };
}

export function stepForCheck(checkId: string): WizardStepId {
  return WIZARD_STEPS.find((step) => (step.checks as readonly string[]).includes(checkId))?.id ?? "readiness";
}

export function statusFromCapability(status: SystemCapability["status"], id: string): ValidationStatus {
  if (status === "unsupported") return "UNSUPPORTED";
  if (status === "blocked_by_policy") return "BLOCKED_BY_POLICY";
  if (status === "unavailable") return "FAILED";
  if (status === "degraded") return "DEGRADED";
  if (status === "unconfigured") {
    return PROVIDER_CHECKS.has(id) ? "REQUIRES_CREDENTIALS" : "UNCONFIGURED";
  }
  return "REQUIRES_USER_ACTION";
}

export function requirementForCheck(id: string): CheckRequirement {
  if (ELECTRON_ONLY_CHECKS.has(id)) return "electron_only";
  return REQUIRED_CHECKS.has(id) ? "required" : "optional";
}

export function providerStatusForCheck(
  id: string,
  kind: RuntimeProviderKind | undefined,
  health?: "healthy" | "degraded" | "unavailable" | "unconfigured",
): ValidationStatus | undefined {
  const isLlm = id === "local_llm" || id === "external_llm";
  const isStt = id === "stt_provider";
  if (!isLlm && !isStt) return undefined;
  if (!kind) return undefined;
  if (kind === "unconfigured") return "REQUIRES_CREDENTIALS";
  if (kind === "mock") return "DEGRADED";
  if (isLlm && id !== `${kind}_llm`) return "UNCONFIGURED";
  if (health === "unconfigured") return "REQUIRES_CREDENTIALS";
  if (health === "unavailable") return "FAILED";
  if (health === "degraded") return "DEGRADED";
  return "NOT_TESTED";
}

export function readinessStatus(
  checks: ValidationCheck[],
  backend: string | undefined,
  websocket: string,
  llmKind: RuntimeProviderKind | undefined,
): string {
  if (backend !== "healthy" || websocket !== "connected") return "NOT_VALIDATED";
  if (llmKind === "mock" || llmKind === "unconfigured") return "CONFIGURATION_REQUIRED";
  if (!llmKind) return "NOT_VALIDATED";

  const activeLlmCheck = llmKind === "local" ? "local_llm" : "external_llm";
  const required = checks.filter((check) =>
    check.id === activeLlmCheck || ["voice_input", "push_to_talk", "stt_provider", "tts"].includes(check.id),
  );
  if (required.some((check) => check.status === "BLOCKED_BY_POLICY")) return "BLOCKED_BY_POLICY";
  if (required.some((check) => ["REQUIRES_CREDENTIALS", "REQUIRES_MODEL", "REQUIRES_RESTART", "UNCONFIGURED"].includes(check.status))) {
    return "CONFIGURATION_REQUIRED";
  }
  if (required.some((check) => check.status !== "PASS")) return "NOT_VALIDATED";

  return checks.some((check) => check.requirement !== "required" && check.status !== "PASS")
    ? "READY_WITH_LIMITATIONS"
    : "READY_FOR_BROWSER_PERSONAL_USE";
}

export function buildInitialValidationChecks(capabilities: SystemCapability[]): ValidationCheck[] {
  return capabilities.map(({ id, label, status, detail }) => ({
    id,
    label,
    status: statusFromCapability(status, id),
    detail,
    requirement: requirementForCheck(id),
  }));
}

export function loadSetupProgress(storage: Pick<Storage, "getItem"> = localStorage): BrowserSetupProgress {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_SETUP_PROGRESS, preferences: { ...EMPTY_SETUP_PROGRESS.preferences } };
    const candidate: unknown = JSON.parse(raw);
    if (!candidate || typeof candidate !== "object") return { ...EMPTY_SETUP_PROGRESS };
    const value = candidate as Record<string, unknown>;
    const rawPreferences = value.preferences && typeof value.preferences === "object"
      ? value.preferences as Record<string, unknown>
      : {};
    const rawEvidence = value.evidence && typeof value.evidence === "object"
      ? value.evidence as Record<string, unknown>
      : {};
    const evidence: Record<string, ValidationEvidence> = {};
    for (const [id, item] of Object.entries(rawEvidence)) {
      if (!CHECK_IDS.has(id) || !item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (!VALIDATION_STATUSES.includes(entry.status as ValidationStatus) || typeof entry.testedAt !== "string" || !Number.isFinite(Date.parse(entry.testedAt)) || !EVIDENCE_CODES.has(entry.code as EvidenceCode)) continue;
      evidence[id] = { status: entry.status as ValidationStatus, testedAt: new Date(entry.testedAt).toISOString(), code: entry.code as EvidenceCode };
    }
    const skippedSteps = Array.isArray(value.skippedSteps)
      ? value.skippedSteps.filter((step): step is WizardStepId => typeof step === "string" && STEP_IDS.has(step))
      : [];
    return {
      stepIndex: typeof value.stepIndex === "number" && Number.isInteger(value.stepIndex)
        ? Math.max(0, Math.min(WIZARD_STEPS.length - 1, value.stepIndex))
        : 0,
      skippedSteps: [...new Set(skippedSteps)],
      evidence,
      preferences: {
        language: typeof rawPreferences.language === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(rawPreferences.language) ? rawPreferences.language : "en-IN",
        timezone: typeof rawPreferences.timezone === "string" && validTimeZone(rawPreferences.timezone) ? rawPreferences.timezone : EMPTY_SETUP_PROGRESS.preferences.timezone,
        voiceURI: typeof rawPreferences.voiceURI === "string" && rawPreferences.voiceURI.length <= 512 ? rawPreferences.voiceURI : "",
        speechRate: typeof rawPreferences.speechRate === "number" && rawPreferences.speechRate >= 0.5 && rawPreferences.speechRate <= 2 ? rawPreferences.speechRate : 1,
        speechVolume: typeof rawPreferences.speechVolume === "number" && rawPreferences.speechVolume >= 0 && rawPreferences.speechVolume <= 1 ? rawPreferences.speechVolume : 1,
        audioRetention: false,
      },
    };
  } catch {
    return { ...EMPTY_SETUP_PROGRESS, preferences: { ...EMPTY_SETUP_PROGRESS.preferences } };
  }
}

export function saveSetupProgress(progress: BrowserSetupProgress, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    const evidence = Object.fromEntries(Object.entries(progress.evidence).flatMap(([id, item]) => {
      if (!CHECK_IDS.has(id) || !VALIDATION_STATUSES.includes(item.status) || !EVIDENCE_CODES.has(item.code) || !Number.isFinite(Date.parse(item.testedAt))) return [];
      return [[id, { status: item.status, testedAt: new Date(item.testedAt).toISOString(), code: item.code }]];
    }));
    const preferences = progress.preferences;
    storage.setItem(STORAGE_KEY, JSON.stringify({
      stepIndex: Math.max(0, Math.min(WIZARD_STEPS.length - 1, progress.stepIndex)),
      skippedSteps: progress.skippedSteps.filter((step) => STEP_IDS.has(step)),
      evidence,
      preferences: {
        language: /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(preferences.language) ? preferences.language : "en-IN",
        timezone: validTimeZone(preferences.timezone) ? preferences.timezone : EMPTY_SETUP_PROGRESS.preferences.timezone,
        voiceURI: preferences.voiceURI.slice(0, 512),
        speechRate: Math.max(0.5, Math.min(2, preferences.speechRate)),
        speechVolume: Math.max(0, Math.min(1, preferences.speechVolume)),
        audioRetention: false,
      },
    }));
  } catch {
    // Managed/private browser storage can be unavailable; the current session still works.
  }
}

export function validationExport(checks: ValidationCheck[], format: "json" | "text", generatedAt = new Date().toISOString()): string {
  const canonical = new Map(browserCapabilityMatrix().map(({ id, label, detail }) => [id, { id, label, detail, requirement: requirementForCheck(id) }]));
  const safeChecks = checks.filter(({ id, status }) => canonical.has(id) && VALIDATION_STATUSES.includes(status)).map(({ id, status }) => ({
    ...canonical.get(id),
    status,
  }));
  const timestamp = Number.isFinite(Date.parse(generatedAt)) ? new Date(generatedAt).toISOString() : new Date(0).toISOString();
  if (format === "json") return JSON.stringify({ generatedAt: timestamp, checks: safeChecks }, null, 2);
  return [`JARVIS managed-device validation (${timestamp})`, ...safeChecks.map((check) => `${check.status}: ${check.label ?? check.id} - ${check.detail ?? ""}`)].join("\n");
}