import { z } from "zod";

export interface ApiResponse<T> {
  data: T;
  requestId: string;
}

export type AssistantState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "planning"
  | "awaiting_confirmation"
  | "executing"
  | "speaking"
  | "completed"
  | "cancelled"
  | "failed"
  | "offline"
  | "Sleeping"
  | "Wake word detected"
  | "Listening"
  | "Transcribing"
  | "Thinking"
  | "Planning"
  | "Awaiting confirmation"
  | "Executing tool"
  | "Speaking"
  | "Completed"
  | "Cancelled"
  | "Error"
  | "Offline";

export type TaskStatus =
  | "pending"
  | "running"
  | "awaiting_confirmation"
  | "completed"
  | "failed"
  | "cancelled";

export type AssistantTaskState = Extract<
  AssistantState,
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "planning"
  | "awaiting_confirmation"
  | "executing"
  | "speaking"
  | "completed"
  | "cancelled"
  | "failed"
  | "offline"
>;

export type IntentKind =
  | "direct_response"
  | "single_tool"
  | "multi_tool"
  | "clarification"
  | "cancellation"
  | "unsupported"
  | "provider_unavailable";

export interface AssistantIntent {
  kind: IntentKind;
  summary: string;
  confidence: number;
  requiresTools: boolean;
}

export interface ToolCall {
  toolId: string;
  arguments: Record<string, unknown>;
}

export interface AssistantPlanStep {
  stepId: string;
  description: string;
  toolCall: ToolCall | null;
}

export interface ExecutionPlan {
  version: 1;
  planId: string;
  steps: AssistantPlanStep[];
}

export type AssistantToolResultStatus =
  | "succeeded"
  | "failed"
  | "denied"
  | "timed_out"
  | "unconfigured";

export interface AssistantToolResult {
  toolCallId: string;
  toolId: string;
  status: AssistantToolResultStatus;
  summary: string;
  output: Record<string, unknown> | null;
  errorCode: string | null;
  durationMs: number;
  untrustedContent: boolean;
}

export interface AssistantMessage {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface SpeechPayload {
  text: string;
  language: string;
  provider: string;
  status: "ready" | "mock" | "unconfigured";
}

export interface ConfirmationRequest {
  confirmationId: string;
  toolId: string;
  riskLevel: RiskLevel;
  expiresAt: string;
  scopes: string[];
  maskedArguments: Record<string, unknown>;
  affectedResources: string[];
}

export interface AuditRecordReference {
  recordId: string;
  action: string;
  outcome: string;
  occurredAt: string;
}

export interface OrchestrationResult {
  commandId: string;
  taskId: string;
  conversationId: string;
  status: TaskStatus;
  state: AssistantTaskState;
  intent: AssistantIntent | null;
  plan: ExecutionPlan | null;
  toolResults: AssistantToolResult[];
  assistantMessage: AssistantMessage | null;
  speechPayload: SpeechPayload | null;
  confirmationRequest: ConfirmationRequest | null;
  auditRecords: AuditRecordReference[];
  errorCode: string | null;
}

export type ToolCategory =
  | "web_information"
  | "desktop_applications"
  | "filesystem"
  | "development"
  | "productivity"
  | "system_monitoring"
  | "custom";

export type RiskLevel = "READ_ONLY" | "LOW" | "MEDIUM" | "HIGH" | "BLOCKED";

export type ToolHealthStatus =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "unconfigured"
  | "disabled";

export interface ToolManifest {
  manifest_version: number;
  tool_id: string;
  display_name: string;
  description: string;
  category: ToolCategory;
  risk_level: RiskLevel;
  required_scopes: string[];
  timeout_seconds: number;
  requires_confirmation: boolean;
  max_output_bytes: number;
  tags: string[];
}

export interface ToolListing {
  manifest: ToolManifest;
  enabled: boolean;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
}

export const toolManifestSchema = z.object({
  manifest_version: z.number().int().min(1),
  tool_id: z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/),
  display_name: z.string().min(1).max(80),
  description: z.string().min(1).max(1000),
  category: z.enum(["web_information", "desktop_applications", "filesystem", "development", "productivity", "system_monitoring", "custom"]),
  risk_level: z.enum(["READ_ONLY", "LOW", "MEDIUM", "HIGH", "BLOCKED"]),
  required_scopes: z.array(z.string()),
  timeout_seconds: z.number().gt(0).max(120),
  requires_confirmation: z.boolean(),
  max_output_bytes: z.number().int().min(1).max(8_388_608),
  tags: z.array(z.string()),
}).strict();

export const toolListingSchema = z.object({
  manifest: toolManifestSchema,
  enabled: z.boolean(),
  input_schema: z.record(z.string(), z.unknown()),
  output_schema: z.record(z.string(), z.unknown()),
}).strict();

export interface JsonSchema {
  type?: string;
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number | boolean | null>;
  default?: unknown;
  [key: string]: unknown;
}

export interface ToolHealth {
  status: ToolHealthStatus;
  message: string;
}

export interface DirectToolResult {
  status:
    | "succeeded"
    | "failed"
    | "denied"
    | "confirmation_required"
    | "unconfigured"
    | "timed_out";
  summary: string;
  data: { output: Record<string, unknown> } | null;
  error_code: string | null;
  duration_ms: number;
  untrusted_content: boolean;
  request_id: string;
  created_at: string;
}

export interface DirectToolExecution {
  result: DirectToolResult;
  confirmationId: string | null;
  toolCallId: string | null;
}

export interface ConfirmationTicket {
  confirmation_id: string;
  tool_id: string;
  risk_level: RiskLevel;
  expires_at: string;
  scopes: string[];
  masked_arguments: Record<string, unknown>;
  affected_resources: string[];
  decision: "approved_once" | "approved_session" | "denied" | null;
}

export interface PermissionGrant {
  id: string;
  tool_id: string;
  scope: string;
  resource_pattern: string;
  created_at: string;
}

export interface AuditRecord {
  id: string;
  occurred_at: string;
  request_id: string;
  tool_call_id: string | null;
  tool_id: string;
  action: string;
  outcome: string;
  decision: string | null;
  confirmation_id: string | null;
  permission_scopes: string[];
  affected_resources: string[];
  masked_arguments: Record<string, unknown>;
  result_summary: string | null;
  error_code: string | null;
  duration_ms: number | null;
}

export interface BackendHealth {
  status: "healthy" | "degraded";
  version: string;
  checkedAt: string;
  checks: Array<{ name: string; status: "healthy" | "unavailable" }>;
}

export interface ProviderHealth {
  status: "healthy" | "degraded" | "unavailable" | "unconfigured";
  message: string;
}

export interface VoiceProviderHealth {
  status: "healthy" | "degraded" | "unavailable" | "unconfigured";
  message: string;
}

export interface VoiceHealth {
  stt: VoiceProviderHealth;
  wakeWord: VoiceProviderHealth;
}

export interface RuntimeConfiguration {
  schemaVersion: 1;
  llm: {
    provider: "unconfigured" | "local_openai_compatible" | "azure_openai" | "other_openai_compatible";
    endpoint: string | null;
    model: string | null;
    apiVersion: string | null;
    authentication: "none" | "environment";
    secretEnvVar: string | null;
    timeoutSeconds: number;
    maxOutputTokens: number;
  };
  stt: {
    provider: "unconfigured" | "faster_whisper" | "azure" | "openai_compatible";
    modelPath: string | null;
    model: string | null;
    device: "cpu" | "cuda" | "auto";
    computeType: "int8" | "int8_float16" | "float16" | "float32";
    language: string;
    endpoint: string | null;
    region: string | null;
    secretEnvVar: string | null;
    timeoutSeconds: number;
  };
  tts: {
    provider: "browser" | "piper" | "azure" | "unconfigured";
    language: string;
    voice: string;
    rate: number;
    volume: number;
  };
  search: {
    provider: "unconfigured" | "brave";
    secretEnvVar: string | null;
    resultLimit: number;
  };
  weather: {
    provider: "open_meteo" | "unconfigured";
    defaultLocation: string;
    temperatureUnit: "celsius" | "fahrenheit";
    timezone: string;
  };
  workspace: {
    approvedRoots: string[];
    allowedFileTypes: string[];
    maxFileBytes: number;
  };
  permissions: {
    defaultMode: "deny" | "ask_every_time";
    approvedWebsites: string[];
    approvedApplications: Record<string, string>;
  };
  audioRetention: false;
}

export interface RuntimeConfigurationEnvelope {
  configuration: RuntimeConfiguration;
  revision: string;
  restartRequired: boolean;
}

export type RuntimeProviderKind = "local" | "external" | "mock" | "unconfigured";

export interface RuntimeProviderStatus {
  restartRequired: boolean;
  providers: {
    llm: RuntimeProviderKind;
    stt: RuntimeProviderKind;
    tts: RuntimeProviderKind;
    search: RuntimeProviderKind;
    weather: RuntimeProviderKind;
  };
}

export interface RuntimeConfigurationIssue {
  path: string;
  message: string;
}

export interface RuntimeConfigurationValidation {
  valid: boolean;
  issues: RuntimeConfigurationIssue[];
}

export interface RuntimeProviderTest {
  status: ProviderHealth["status"];
  message?: string;
  issues?: RuntimeConfigurationIssue[];
}

export interface WakeDetection {
  detected: boolean;
}

export interface VoiceTranscription {
  sessionId: string;
  text: string;
  language: string;
  provider: string;
}

export interface BackendEvent<T extends string = string, P = unknown> {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
  correlationId: string;
  type: T;
  payload: P;
}

export type AssistantEvent =
  | BackendEvent<"assistant.state.changed", { state: AssistantState }>
  | BackendEvent<
      "assistant.plan.created",
      { planId: string; steps: Array<{ stepId: string; description: string; toolId: string | null }> }
    >
  | BackendEvent<"assistant.response.partial", { text: string; sequence: number }>
  | BackendEvent<"assistant.response.completed", { messageId: string; text: string }>;

export type PermissionEvent =
  | BackendEvent<
      "permission.requested",
      { confirmationId: string; toolId: string; riskLevel: RiskLevel }
    >
  | BackendEvent<
      "permission.resolved",
      { confirmationId: string; decision: "approved_once" | "approved_session" | "denied" }
    >;

export type ToolEvent =
  | BackendEvent<"tool.started", { toolCallId: string; toolId: string }>
  | BackendEvent<
      "tool.progress",
      { toolCallId: string; message: string; progress: number | null }
    >
  | BackendEvent<
      "tool.completed",
      { toolCallId: string; summary: string; durationMs: number }
    >
  | BackendEvent<"tool.failed", { toolCallId: string; errorCode: string }>;

export type TaskEvent = BackendEvent<
  "task.updated",
  { taskId: string; status: TaskStatus }
>;

export type NotificationEvent = BackendEvent<
  "notification.created",
  { notificationId: string; severity: "info" | "warning" | "error" | "security"; title: string }
>;

export type ProviderHealthEvent = BackendEvent<
  "provider.health.changed",
  { provider: string; status: ProviderHealth["status"] }
>;

export type SystemMetricEvent = BackendEvent<
  "system.metric.updated",
  { metric: string; value: number; unit: string }
>;

export type VoiceEvent =
  | BackendEvent<"voice.wakeword.detected", { phrase: string }>
  | BackendEvent<"voice.recording.started", { sessionId: string }>
  | BackendEvent<"voice.recording.stopped", { sessionId: string; reason: "completed" | "cancelled" | "timeout" | "no_speech" | "error" }>
  | BackendEvent<"voice.audio.level", { level: number; durationMs: number }>
  | BackendEvent<"voice.speech.started", { sessionId: string }>
  | BackendEvent<"voice.speech.ended", { sessionId: string; durationMs: number }>
  | BackendEvent<"voice.transcript.partial", { text: string; sequence: number }>
  | BackendEvent<"voice.transcript.final", { commandId: string; text: string; language: string }>
  | BackendEvent<"voice.transcription.failed", { sessionId: string; errorCode: string }>;

export type AudioPlaybackEvent =
  | BackendEvent<"audio.playback.started", { playbackId: string }>
  | BackendEvent<
      "audio.playback.stopped",
      { playbackId: string; reason: "completed" | "interrupted" | "cancelled" | "error" }
    >
  | BackendEvent<"audio.playback.progress", { playbackId: string; progress: number; elapsedMs: number }>
  | BackendEvent<"audio.playback.completed", { playbackId: string }>;

export type VoiceProviderHealthEvent = BackendEvent<
  "voice.provider.health.changed",
  { provider: "stt" | "tts" | "vad" | "wake_word"; status: ProviderHealth["status"] }
>;

export type JarvisEvent =
  | AssistantEvent
  | PermissionEvent
  | ToolEvent
  | TaskEvent
  | NotificationEvent
  | ProviderHealthEvent
  | SystemMetricEvent
  | VoiceEvent
  | AudioPlaybackEvent
  | VoiceProviderHealthEvent;

const eventBase = {
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  occurredAt: z.string(),
  correlationId: z.string().uuid(),
};

const assistantStates = [
  "idle", "listening", "transcribing", "thinking", "planning", "awaiting_confirmation",
  "executing", "speaking", "completed", "cancelled", "failed", "offline", "Sleeping",
  "Wake word detected", "Listening", "Transcribing", "Thinking", "Planning",
  "Awaiting confirmation", "Executing tool", "Speaking", "Completed", "Cancelled", "Error",
  "Offline",
] as const;

export const backendEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("assistant.state.changed"), payload: z.object({ state: z.enum(assistantStates) }) }),
  z.object({ ...eventBase, type: z.literal("assistant.plan.created"), payload: z.object({ planId: z.string().uuid(), steps: z.array(z.object({ stepId: z.string(), description: z.string(), toolId: z.string().nullable() })) }) }),
  z.object({ ...eventBase, type: z.literal("assistant.response.partial"), payload: z.object({ text: z.string(), sequence: z.number().int().nonnegative() }) }),
  z.object({ ...eventBase, type: z.literal("assistant.response.completed"), payload: z.object({ messageId: z.string().uuid(), text: z.string() }) }),
  z.object({ ...eventBase, type: z.literal("permission.requested"), payload: z.object({ confirmationId: z.string().uuid(), toolId: z.string(), riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "BLOCKED"]) }) }),
  z.object({ ...eventBase, type: z.literal("permission.resolved"), payload: z.object({ confirmationId: z.string().uuid(), decision: z.enum(["approved_once", "approved_session", "denied"]) }) }),
  z.object({ ...eventBase, type: z.literal("tool.started"), payload: z.object({ toolCallId: z.string().uuid(), toolId: z.string() }) }),
  z.object({ ...eventBase, type: z.literal("tool.progress"), payload: z.object({ toolCallId: z.string().uuid(), message: z.string(), progress: z.number().min(0).max(1).nullable() }) }),
  z.object({ ...eventBase, type: z.literal("tool.completed"), payload: z.object({ toolCallId: z.string().uuid(), summary: z.string(), durationMs: z.number().int().nonnegative() }) }),
  z.object({ ...eventBase, type: z.literal("tool.failed"), payload: z.object({ toolCallId: z.string().uuid(), errorCode: z.string() }) }),
  z.object({ ...eventBase, type: z.literal("task.updated"), payload: z.object({ taskId: z.string().uuid(), status: z.enum(["pending", "running", "awaiting_confirmation", "completed", "failed", "cancelled"]) }) }),
  z.object({ ...eventBase, type: z.literal("notification.created"), payload: z.object({ notificationId: z.string().uuid(), severity: z.enum(["info", "warning", "error", "security"]), title: z.string() }) }),
  z.object({ ...eventBase, type: z.literal("provider.health.changed"), payload: z.object({ provider: z.string(), status: z.enum(["healthy", "degraded", "unavailable", "unconfigured"]) }) }),
  z.object({ ...eventBase, type: z.literal("system.metric.updated"), payload: z.object({ metric: z.string(), value: z.number(), unit: z.string() }) }),
  z.object({ ...eventBase, type: z.literal("voice.wakeword.detected"), payload: z.object({ phrase: z.string() }).strict() }),
  z.object({ ...eventBase, type: z.literal("voice.recording.started"), payload: z.object({ sessionId: z.string().uuid() }).strict() }),
  z.object({ ...eventBase, type: z.literal("voice.recording.stopped"), payload: z.object({ sessionId: z.string().uuid(), reason: z.enum(["completed", "cancelled", "timeout", "no_speech", "error"]) }).strict() }),
  z.object({ ...eventBase, type: z.literal("voice.audio.level"), payload: z.object({ level: z.number().min(0).max(1), durationMs: z.number().int().nonnegative() }).strict() }),
  z.object({ ...eventBase, type: z.literal("voice.speech.started"), payload: z.object({ sessionId: z.string().uuid() }).strict() }),
  z.object({ ...eventBase, type: z.literal("voice.speech.ended"), payload: z.object({ sessionId: z.string().uuid(), durationMs: z.number().int().nonnegative() }).strict() }),
  z.object({ ...eventBase, type: z.literal("voice.transcript.partial"), payload: z.object({ text: z.string(), sequence: z.number().int().nonnegative() }).strict() }),
  z.object({ ...eventBase, type: z.literal("voice.transcript.final"), payload: z.object({ commandId: z.string().uuid(), text: z.string(), language: z.string() }).strict() }),
  z.object({ ...eventBase, type: z.literal("voice.transcription.failed"), payload: z.object({ sessionId: z.string().uuid(), errorCode: z.string() }).strict() }),
  z.object({ ...eventBase, type: z.literal("audio.playback.started"), payload: z.object({ playbackId: z.string().uuid() }).strict() }),
  z.object({ ...eventBase, type: z.literal("audio.playback.stopped"), payload: z.object({ playbackId: z.string().uuid(), reason: z.enum(["completed", "interrupted", "cancelled", "error"]) }).strict() }),
  z.object({ ...eventBase, type: z.literal("audio.playback.progress"), payload: z.object({ playbackId: z.string().uuid(), progress: z.number().min(0).max(1), elapsedMs: z.number().int().nonnegative() }).strict() }),
  z.object({ ...eventBase, type: z.literal("audio.playback.completed"), payload: z.object({ playbackId: z.string().uuid() }).strict() }),
  z.object({ ...eventBase, type: z.literal("voice.provider.health.changed"), payload: z.object({ provider: z.enum(["stt", "tts", "vad", "wake_word"]), status: z.enum(["healthy", "degraded", "unavailable", "unconfigured"]) }).strict() }),
]);

export type ToolTestResponse = {
  result: DirectToolResult;
  confirmationId: string | null;
  toolCallId: string | null;
};

export type LocalNotification = {
  id: string;
  title: string;
  severity: "info" | "warning" | "error" | "security";
  occurredAt: string;
  read: boolean;
  relatedId?: string;
};

export type ConversationActivity = {
  id: string;
  kind: "user" | "assistant" | "plan" | "tool" | "state";
  content: string;
  createdAt: string;
  taskId?: string;
  toolId?: string;
  status?: string;
};