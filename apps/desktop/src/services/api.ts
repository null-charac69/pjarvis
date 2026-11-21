import type {
  ApiResponse,
  AuditRecord,
  BackendHealth,
  ConfirmationTicket,
  DirectToolExecution,
  OrchestrationResult,
  PermissionGrant,
  ProviderHealth,
  RuntimeConfiguration,
  RuntimeConfigurationEnvelope,
  RuntimeConfigurationValidation,
  RuntimeProviderStatus,
  RuntimeProviderTest,
  ToolHealth,
  ToolListing,
  VoiceHealth,
  VoiceTranscription,
  WakeDetection,
} from "@/types/contracts";
import { toolListingSchema } from "@/types/contracts";
import { clearBrowserSession, getBrowserSessionToken, isBrowserDeployment } from "@/services/deployment";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function baseUrl(): Promise<string> {
  if (import.meta.env.DEV) return window.location.origin;
  if (isBrowserDeployment()) return window.location.origin;
  if (window.jarvis) return (await window.jarvis.getBackendBaseUrl()).replace(/\/$/, "");
  throw new ApiError("The desktop bridge is unavailable.", 0, "desktop_bridge_unavailable");
}

async function request<T>(path: string, init?: RequestInit, retrySession = true): Promise<T> {
  const root = await baseUrl();
  let response: Response;
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (isBrowserDeployment()) {
      headers["X-Jarvis-Session-Token"] = await getBrowserSessionToken();
    }
    response = await fetch(`${root}/api/v1${path}`, {
      ...init,
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers,
    });
  } catch {
    throw new ApiError("The local backend could not be reached.", 0, "backend_offline");
  }

  if (!response.ok) {
    let message = `Backend request failed (${response.status}).`;
    let code: string | undefined;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "detail" in body) {
        const detail = body.detail;
        if (typeof detail === "string") message = detail;
        if (detail && typeof detail === "object" && "errors" in detail && Array.isArray(detail.errors)) {
          const safeErrors = detail.errors.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const issue = entry as Record<string, unknown>;
            if (typeof issue.path !== "string" || typeof issue.message !== "string") return [];
            return [`${issue.path}: ${issue.message}`];
          });
          if (safeErrors.length) message = safeErrors.join("; ");
        }
      }
      if (body && typeof body === "object" && "error" in body) {
        const error = body.error;
        if (error && typeof error === "object") {
          if ("message" in error && typeof error.message === "string") message = error.message;
          if ("code" in error && typeof error.code === "string") code = error.code;
        }
      }
    } catch {
      // Preserve the safe status-only message when the server has no JSON body.
    }
    if (
      retrySession
      && isBrowserDeployment()
      && response.status === 401
      && code === "browser_session_required"
    ) {
      clearBrowserSession();
      return request<T>(path, init, false);
    }
    throw new ApiError(message, response.status, code);
  }

  return (await response.json()) as T;
}

function data<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  return request<ApiResponse<T>>(path, init);
}

function jsonBody(body: unknown): string {
  return JSON.stringify(body);
}

export const api = {
  health: async (signal?: AbortSignal) =>
    (await data<BackendHealth>("/health", { signal })).data,
  llmHealth: async (signal?: AbortSignal) =>
    (await data<ProviderHealth>("/assistant/providers/llm/health", { signal })).data,
  voiceHealth: async (signal?: AbortSignal) =>
    (await data<VoiceHealth>("/voice/health", { signal })).data,
  runtimeConfiguration: async (signal?: AbortSignal) =>
    (await data<RuntimeConfigurationEnvelope>("/configuration", { signal })).data,
  runtimeProviderStatus: async (signal?: AbortSignal) =>
    (await data<RuntimeProviderStatus>("/configuration/status", { signal })).data,
  validateRuntimeConfiguration: async (configuration: RuntimeConfiguration) =>
    (await data<RuntimeConfigurationValidation>("/configuration/validate", {
      method: "POST",
      body: jsonBody(configuration),
    })).data,
  testRuntimeProvider: async (component: "llm" | "stt", configuration: RuntimeConfiguration) =>
    (await data<RuntimeProviderTest>("/configuration/test", {
      method: "POST",
      body: jsonBody({ component, configuration }),
    })).data,
  saveRuntimeConfiguration: async (configuration: RuntimeConfiguration, expectedRevision: string) =>
    (await data<{ saved: boolean; revision?: string; restartRequired?: boolean; issues?: RuntimeConfigurationValidation["issues"] }>("/configuration/save", {
      method: "POST",
      body: jsonBody({ configuration, expectedRevision }),
    })).data,
  rollbackRuntimeConfiguration: async (expectedRevision: string) =>
    (await data<{ rolledBack: boolean; revision: string; restartRequired: boolean }>("/configuration/rollback", {
      method: "POST",
      body: jsonBody({ expectedRevision }),
    })).data,
  transcribeVoice: async (
    audio: Blob,
    sessionId: string,
    final: boolean,
    sequence: number,
  ) => {
    const query = new URLSearchParams({ session_id: sessionId, final: String(final), sequence: String(sequence) });
    return (await data<VoiceTranscription>(`/voice/transcriptions?${query}`, {
      method: "POST",
      body: audio,
      headers: { "Content-Type": audio.type || "audio/webm" },
    })).data;
  },
  detectWakeWord: async (audio: Blob, sessionId: string) => {
    const query = new URLSearchParams({ session_id: sessionId });
    return (await data<WakeDetection>(`/voice/wakeword?${query}`, {
      method: "POST",
      body: audio,
      headers: { "Content-Type": "application/octet-stream" },
    })).data;
  },
  listTools: async (signal?: AbortSignal) =>
    toolListingSchema.array().parse((await data<unknown>("/tools", { signal })).data) as ToolListing[],
  toolHealth: async (toolId: string, signal?: AbortSignal) =>
    (await data<ToolHealth>(`/tools/${encodeURIComponent(toolId)}/health`, { signal })).data,
  setToolEnabled: async (toolId: string, enabled: boolean) =>
    (await data<{ tool_id: string; enabled: boolean }>(
      `/tools/${encodeURIComponent(toolId)}/enabled`,
      { method: "PATCH", body: jsonBody({ enabled }) },
    )).data,
  executeTool: async (toolId: string, arguments_: Record<string, unknown>, confirmationId?: string) =>
    (await data<DirectToolExecution>(`/tools/${encodeURIComponent(toolId)}/execute`, {
      method: "POST",
      body: jsonBody({ arguments: arguments_, ...(confirmationId ? { confirmationId } : {}) }),
    })).data,
  submitCommand: async (transcript: string, conversationId?: string) =>
    (await data<OrchestrationResult>("/assistant/commands", {
      method: "POST",
      body: jsonBody({ transcript, ...(conversationId ? { conversationId } : {}) }),
    })).data,
  getCommand: async (commandId: string, signal?: AbortSignal) =>
    (await data<OrchestrationResult>(`/assistant/commands/${encodeURIComponent(commandId)}`, { signal })).data,
  getTask: async (taskId: string, signal?: AbortSignal) =>
    (await data<OrchestrationResult>(`/tasks/${encodeURIComponent(taskId)}`, { signal })).data,
  cancelTask: async (taskId: string) =>
    (await data<OrchestrationResult>(`/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" })).data,
  resolveAssistantConfirmation: async (
    commandId: string,
    decision: "approved_once" | "approved_session" | "denied",
  ) =>
    (await data<OrchestrationResult>(
      `/assistant/commands/${encodeURIComponent(commandId)}/confirmation`,
      { method: "POST", body: jsonBody({ decision }) },
    )).data,
  getConfirmation: async (confirmationId: string, signal?: AbortSignal) =>
    (await data<ConfirmationTicket>(
      `/permissions/confirmations/${encodeURIComponent(confirmationId)}`,
      { signal },
    )).data,
  resolveDirectConfirmation: async (
    confirmationId: string,
    decision: "approved_once" | "approved_session" | "denied",
  ) =>
    (await data<ConfirmationTicket>(
      `/permissions/confirmations/${encodeURIComponent(confirmationId)}`,
      { method: "POST", body: jsonBody({ decision }) },
    )).data,
  createGrant: async (toolId: string, scope: string, resourcePattern = "*") =>
    (await data<PermissionGrant>("/permissions/grants", {
      method: "POST",
      body: jsonBody({ tool_id: toolId, scope, resource_pattern: resourcePattern }),
    })).data,
  listGrants: async (signal?: AbortSignal) =>
    (await data<PermissionGrant[]>("/permissions/grants", { signal })).data,
  revokeGrant: async (grantId: string) =>
    (await data<{ revoked: boolean }>(`/permissions/grants/${encodeURIComponent(grantId)}`, {
      method: "DELETE",
    })).data,
  history: async (options: { limit?: number; offset?: number; conversationId?: string } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    query.set("limit", String(options.limit ?? 100));
    query.set("offset", String(options.offset ?? 0));
    if (options.conversationId) query.set("conversation_id", options.conversationId);
    return (await data<OrchestrationResult[]>(`/assistant/history?${query}`, { signal })).data;
  },
  audit: async (limit = 100, offset = 0, signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return (await data<AuditRecord[]>(`/audit?${query}`, { signal })).data;
  },
};