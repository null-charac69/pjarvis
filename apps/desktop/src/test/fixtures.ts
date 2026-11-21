import type {
  AuditRecord,
  BackendHealth,
  OrchestrationResult,
  ProviderHealth,
  RuntimeConfigurationEnvelope,
  ToolListing,
  VoiceHealth,
} from "@/types/contracts";
import { vi } from "vitest";

export const backendHealth: BackendHealth = {
  status: "healthy",
  version: "0.4.0",
  checkedAt: "2026-10-06T12:00:00.000Z",
  checks: [{ name: "database", status: "healthy" }],
};

export const providerHealth: ProviderHealth = {
  status: "unconfigured",
  message: "No language model provider is configured.",
};

export const voiceHealth: VoiceHealth = {
  stt: { status: "unconfigured", message: "No speech provider is configured." },
  wakeWord: { status: "unconfigured", message: "No local wake model is configured." },
};

export const runtimeConfiguration: RuntimeConfigurationEnvelope = {
  revision: "test-revision",
  restartRequired: false,
  configuration: {
    schemaVersion: 1,
    llm: { provider: "unconfigured", endpoint: null, model: null, apiVersion: null, authentication: "none", secretEnvVar: null, timeoutSeconds: 30, maxOutputTokens: 2048 },
    stt: { provider: "unconfigured", modelPath: null, model: null, device: "cpu", computeType: "int8", language: "en-IN", endpoint: null, region: null, secretEnvVar: null, timeoutSeconds: 30 },
    tts: { provider: "browser", language: "en-IN", voice: "", rate: 1, volume: 1 },
    search: { provider: "unconfigured", secretEnvVar: null, resultLimit: 5 },
    weather: { provider: "open_meteo", defaultLocation: "", temperatureUnit: "celsius", timezone: "UTC" },
    workspace: { approvedRoots: [], allowedFileTypes: [".txt", ".md"], maxFileBytes: 262144 },
    permissions: { defaultMode: "ask_every_time", approvedWebsites: [], approvedApplications: {} },
    audioRetention: false,
  },
};

export const runtimeProviderStatus = {
  restartRequired: false,
  providers: { llm: "mock", stt: "mock", tts: "mock", search: "unconfigured", weather: "external" },
} as const;

export const completedTask: OrchestrationResult = {
  commandId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  conversationId: "33333333-3333-4333-8333-333333333333",
  status: "completed",
  state: "completed",
  intent: { kind: "direct_response", summary: "Check local readiness", confidence: 1, requiresTools: false },
  plan: { version: 1, planId: "44444444-4444-4444-8444-444444444444", steps: [] },
  toolResults: [],
  assistantMessage: {
    messageId: "55555555-5555-4555-8555-555555555555",
    role: "assistant",
    content: "The local service is ready.",
    createdAt: "2026-10-06T12:00:00.000Z",
  },
  speechPayload: null,
  confirmationRequest: null,
  auditRecords: [],
  errorCode: null,
};

export const runningTask: OrchestrationResult = {
  ...completedTask,
  status: "running",
  state: "executing",
  assistantMessage: null,
};

export const sampleTool: ToolListing = {
  manifest: {
    manifest_version: 1,
    tool_id: "system.health",
    display_name: "System health",
    description: "Read local backend readiness.",
    category: "system_monitoring",
    risk_level: "READ_ONLY",
    required_scopes: [],
    timeout_seconds: 5,
    requires_confirmation: false,
    max_output_bytes: 2048,
    tags: ["health"],
  },
  enabled: true,
  input_schema: {
    type: "object",
    required: ["count"],
    properties: { count: { type: "integer", minimum: 1, default: 1 } },
  },
  output_schema: { type: "object" },
};

export const sampleAuditRecord: AuditRecord = {
  id: "66666666-6666-4666-8666-666666666666",
  occurred_at: "2026-10-06T12:00:00.000Z",
  request_id: "77777777-7777-4777-8777-777777777777",
  tool_call_id: null,
  tool_id: "system.health",
  action: "execute",
  outcome: "succeeded",
  decision: null,
  confirmation_id: null,
  permission_scopes: [],
  affected_resources: [],
  masked_arguments: {},
  result_summary: "The API is healthy.",
  error_code: null,
  duration_ms: 12,
};

export type FetchCall = { url: string; method: string; body?: string };

export function installApiFetch(
  resolve: (call: FetchCall) => { data: unknown; status?: number } | undefined = () => undefined,
) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.origin);
    const call = { url: url.pathname, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined };
    calls.push(call);
    const override = resolve(call);
    let data: unknown = [];
    if (url.pathname === "/api/v1/voice/health") data = voiceHealth;
    else if (url.pathname === "/api/v1/configuration") data = runtimeConfiguration;
    else if (url.pathname === "/api/v1/configuration/status") data = runtimeProviderStatus;
    else if (url.pathname.endsWith("/health")) data = backendHealth;
    if (url.pathname.endsWith("/providers/llm/health")) data = providerHealth;
    if (url.pathname.endsWith("/tools")) data = [sampleTool];
    if (url.pathname.endsWith("/assistant/commands") && call.method === "POST") data = completedTask;
    if (url.pathname.endsWith("/assistant/history")) data = [];
    if (url.pathname.endsWith("/audit")) data = [sampleAuditRecord];
    if (url.pathname.endsWith("/permissions/grants")) data = [];
    if (url.pathname.endsWith("/health") && url.pathname.includes("/tools/")) data = { status: "healthy", message: "Ready" };
    const selected = override ?? { data };
    return {
      ok: (selected.status ?? 200) >= 200 && (selected.status ?? 200) < 300,
      status: selected.status ?? 200,
      json: async () => selected.status && selected.status >= 400
        ? { detail: "Test backend failure" }
        : { data: selected.data, requestId: "test-request" },
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

export class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  url: string;
  private listeners = new Map<string, Array<(event: Event) => void>>();
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; this.emit("close"); }
  open() { this.readyState = MockWebSocket.OPEN; this.emit("open"); }
  message(data: string) { this.emit("message", new MessageEvent("message", { data })); }
  emit(type: string, event: Event = new Event(type)) { this.listeners.get(type)?.forEach((listener) => listener(event)); }
}

export function installMockWebSocket() {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  return MockWebSocket.instances;
}