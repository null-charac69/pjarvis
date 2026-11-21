import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "@/state/app-store";
import type { JarvisEvent } from "@/types/contracts";

const base = {
  schemaVersion: 1 as const,
  eventId: "11111111-1111-4111-8111-111111111111",
  occurredAt: "2026-10-06T12:00:00.000Z",
  correlationId: "22222222-2222-4222-8222-222222222222",
};

function resetStore() {
  useAppStore.setState({
    assistantState: "idle",
    voiceLevel: 0,
    voiceShortcutRequest: 0,
    backendConnected: false,
    eventConnection: "disconnected",
    activeTaskId: null,
    activeCommandId: null,
    latestTask: null,
    pendingConfirmation: null,
    events: [],
    timeline: [],
    notifications: [],
    appError: null,
  });
}

describe("application event store", () => {
  beforeEach(resetStore);

  it("ignores duplicate event IDs instead of duplicating activity or notifications", () => {
    const event: JarvisEvent = {
      ...base,
      type: "notification.created",
      payload: {
        notificationId: "33333333-3333-4333-8333-333333333333",
        severity: "warning",
        title: "Backend warning",
      },
    };

    useAppStore.getState().pushEvent(event);
    useAppStore.getState().pushEvent(event);

    expect(useAppStore.getState().events).toHaveLength(1);
    expect(useAppStore.getState().notifications).toHaveLength(1);
  });

  it("updates assistant state and records partial response and tool lifecycle activity", () => {
    const push = useAppStore.getState().pushEvent;
    push({ ...base, type: "assistant.state.changed", payload: { state: "thinking" } });
    push({ ...base, eventId: "44444444-4444-4444-8444-444444444444", type: "assistant.response.partial", payload: { text: "Working", sequence: 0 } });
    push({ ...base, eventId: "99999999-9999-4999-8999-999999999999", type: "assistant.response.partial", payload: { text: "Working safely", sequence: 1 } });
    push({ ...base, eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type: "assistant.response.completed", payload: { messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", text: "Work complete" } });
    push({ ...base, eventId: "55555555-5555-4555-8555-555555555555", type: "tool.started", payload: { toolCallId: "66666666-6666-4666-8666-666666666666", toolId: "system.health" } });
    push({ ...base, eventId: "77777777-7777-4777-8777-777777777777", type: "tool.progress", payload: { toolCallId: "66666666-6666-4666-8666-666666666666", message: "Checking", progress: 0.5 } });
    push({ ...base, eventId: "88888888-8888-4888-8888-888888888888", type: "tool.completed", payload: { toolCallId: "66666666-6666-4666-8666-666666666666", summary: "Healthy", durationMs: 25 } });

    expect(useAppStore.getState().assistantState).toBe("thinking");
    expect(useAppStore.getState().timeline.map((item) => item.content)).toEqual([
      "Assistant state: thinking",
      "Work complete",
      "Started system.health",
      "Checking",
      "Healthy",
    ]);
    expect(useAppStore.getState().timeline.at(-1)?.status).toBe("completed");
  });

  it("creates permission and failure notifications and reflects failed tool activity", () => {
    const push = useAppStore.getState().pushEvent;
    push({ ...base, type: "permission.requested", payload: { confirmationId: "33333333-3333-4333-8333-333333333333", toolId: "filesystem.read", riskLevel: "HIGH" } });
    push({ ...base, eventId: "44444444-4444-4444-8444-444444444444", type: "tool.failed", payload: { toolCallId: "55555555-5555-4555-8555-555555555555", errorCode: "tool_timeout" } });

    expect(useAppStore.getState().notifications.map((item) => item.severity)).toEqual(["error", "security"]);
    expect(useAppStore.getState().timeline.at(-1)?.status).toBe("failed");
  });

  it("enters listening only after a real wake-word event and does not store its audio", () => {
    useAppStore.getState().pushEvent({
      ...base,
      type: "voice.wakeword.detected",
      payload: { phrase: "Jarvis" },
    });

    expect(useAppStore.getState().assistantState).toBe("listening");
    expect(useAppStore.getState().timeline).toHaveLength(0);
    expect(JSON.stringify(useAppStore.getState().events)).not.toContain("audio");
  });
});