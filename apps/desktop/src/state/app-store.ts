import { create } from "zustand";
import { defaultDesktopPreferences, type DesktopPreferences, type DesktopPreferencesPatch } from "../../electron/contracts";
import type {
  AssistantState,
  BackendEvent,
  ConversationActivity,
  JarvisEvent,
  LocalNotification,
  OrchestrationResult,
} from "@/types/contracts";
import type { EventConnectionState } from "@/services/events";

type PendingConfirmation =
  | {
      mode: "assistant";
      commandId: string;
      taskId: string;
      confirmationId: string;
      toolId: string;
      riskLevel: string;
      scopes: string[];
      arguments: Record<string, unknown>;
      resources: string[];
    }
  | {
      mode: "tool";
      toolId: string;
      arguments: Record<string, unknown>;
      confirmationId: string;
      ticket?: {
        riskLevel: string;
        scopes: string[];
        arguments: Record<string, unknown>;
        resources: string[];
      };
    };

type AppState = {
  assistantState: AssistantState;
  voiceLevel: number;
  voiceShortcutRequest: number;
  backendConnected: boolean;
  eventConnection: EventConnectionState;
  activeTaskId: string | null;
  activeCommandId: string | null;
  latestTask: OrchestrationResult | null;
  pendingConfirmation: PendingConfirmation | null;
  events: JarvisEvent[];
  timeline: ConversationActivity[];
  notifications: LocalNotification[];
  appError: string | null;
  preferences: DesktopPreferences;
  preferencesLoaded: boolean;
  setAssistantState: (state: AssistantState) => void;
  setVoiceLevel: (level: number) => void;
  requestVoiceShortcut: () => void;
  setBackendConnected: (connected: boolean) => void;
  setEventConnection: (state: EventConnectionState) => void;
  setLatestTask: (task: OrchestrationResult | null) => void;
  setPendingConfirmation: (value: PendingConfirmation | null) => void;
  pushEvent: (event: JarvisEvent) => void;
  addTimeline: (activity: ConversationActivity) => void;
  clearTimeline: () => void;
  addNotification: (notification: LocalNotification) => void;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  clearNotifications: () => void;
  setAppError: (message: string | null) => void;
  setPreferences: (preferences: DesktopPreferences) => void;
  setPreferencesLoaded: (loaded: boolean) => void;
};

export type PendingConfirmationInput = PendingConfirmation;

function eventNotification(event: JarvisEvent): LocalNotification | null {
  if (event.type === "notification.created") {
    return {
      id: event.payload.notificationId,
      title: event.payload.title,
      severity: event.payload.severity,
      occurredAt: event.occurredAt,
      read: false,
      relatedId: event.correlationId,
    };
  }
  if (event.type === "permission.requested") {
    return {
      id: event.payload.confirmationId,
      title: `Permission requested: ${event.payload.toolId}`,
      severity: event.payload.riskLevel === "HIGH" ? "security" : "warning",
      occurredAt: event.occurredAt,
      read: false,
      relatedId: event.correlationId,
    };
  }
  if (event.type === "tool.failed") {
    return {
      id: event.eventId,
      title: `Tool failed: ${event.payload.errorCode}`,
      severity: "error",
      occurredAt: event.occurredAt,
      read: false,
      relatedId: event.correlationId,
    };
  }
  return null;
}

export const useAppStore = create<AppState>((set) => ({
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
  preferences: defaultDesktopPreferences,
  preferencesLoaded: false,
  setAssistantState: (assistantState) => set({ assistantState }),
  setVoiceLevel: (voiceLevel) => set({ voiceLevel }),
  requestVoiceShortcut: () => set((state) => ({ voiceShortcutRequest: state.voiceShortcutRequest + 1 })),
  setBackendConnected: (backendConnected) => set({ backendConnected }),
  setEventConnection: (eventConnection) => set({ eventConnection }),
  setLatestTask: (latestTask) =>
    set({
      latestTask,
      activeTaskId:
        latestTask && ["pending", "running", "awaiting_confirmation"].includes(latestTask.status)
          ? latestTask.taskId
          : null,
      activeCommandId:
        latestTask && ["pending", "running", "awaiting_confirmation"].includes(latestTask.status)
          ? latestTask.commandId
          : null,
      assistantState: latestTask?.state ?? "idle",
    }),
  setPendingConfirmation: (pendingConfirmation) => set({ pendingConfirmation }),
  pushEvent: (event: JarvisEvent) =>
    set((state) => {
      if (state.events.some((current) => current.eventId === event.eventId)) return state;
      const notification = eventNotification(event);
      const timelineItem = toTimeline(event);
      const streamedResponseIndex = timelineItem?.kind === "assistant"
        ? state.timeline.reduce((latestIndex, item, index) =>
            item.kind === "assistant" && item.taskId === timelineItem.taskId
              ? index
              : latestIndex,
          -1)
        : -1;
      const timeline = !timelineItem
        ? state.timeline
        : streamedResponseIndex >= 0
          ? state.timeline.map((item, index) => index === streamedResponseIndex ? timelineItem : item)
          : [...state.timeline, timelineItem].slice(-200);
      return {
        events: [...state.events, event].slice(-120),
        ...(notification
          ? { notifications: [notification, ...state.notifications].slice(0, 100) }
          : {}),
        ...(timelineItem ? { timeline } : {}),
        ...(event.type === "assistant.state.changed" ? { assistantState: event.payload.state } : {}),
        ...(event.type === "voice.wakeword.detected" ? { assistantState: "listening" as const } : {}),
        ...(event.type === "task.updated"
          ? { activeTaskId: event.payload.status === "running" || event.payload.status === "pending" || event.payload.status === "awaiting_confirmation" ? event.payload.taskId : state.activeTaskId }
          : {}),
      };
    }),
  addTimeline: (activity) => set((state) => ({ timeline: [...state.timeline, activity].slice(-200) })),
  clearTimeline: () => set({ timeline: [] }),
  addNotification: (notification) =>
    set((state) => ({ notifications: [notification, ...state.notifications].slice(0, 100) })),
  markNotificationRead: (id) =>
    set((state) => ({ notifications: state.notifications.map((item) => item.id === id ? { ...item, read: true } : item) })),
  markAllNotificationsRead: () =>
    set((state) => ({ notifications: state.notifications.map((item) => ({ ...item, read: true })) })),
  clearNotifications: () => set({ notifications: [] }),
  setAppError: (appError) => set({ appError }),
  setPreferences: (preferences) => set({ preferences }),
  setPreferencesLoaded: (preferencesLoaded) => set({ preferencesLoaded }),
}));

function toTimeline(event: JarvisEvent): ConversationActivity | null {
  const createdAt = event.occurredAt;
  switch (event.type) {
    case "assistant.state.changed":
      return { id: event.eventId, kind: "state", content: `Assistant state: ${event.payload.state}`, createdAt };
    case "assistant.plan.created":
      return { id: event.eventId, kind: "plan", content: `${event.payload.steps.length} validated plan step(s)`, createdAt, taskId: event.correlationId };
    case "assistant.response.partial":
      return { id: event.eventId, kind: "assistant", content: event.payload.text, createdAt, taskId: event.correlationId };
    case "assistant.response.completed":
      return { id: event.payload.messageId, kind: "assistant", content: event.payload.text, createdAt, taskId: event.correlationId };
    case "tool.started":
      return { id: event.payload.toolCallId, kind: "tool", content: `Started ${event.payload.toolId}`, createdAt, taskId: event.correlationId, toolId: event.payload.toolId, status: "running" };
    case "tool.progress":
      return { id: event.eventId, kind: "tool", content: event.payload.message, createdAt, taskId: event.correlationId, status: "running" };
    case "tool.completed":
      return { id: event.payload.toolCallId, kind: "tool", content: event.payload.summary, createdAt, taskId: event.correlationId, status: "completed" };
    case "tool.failed":
      return { id: event.payload.toolCallId, kind: "tool", content: `Tool failed (${event.payload.errorCode})`, createdAt, taskId: event.correlationId, status: "failed" };
    case "permission.requested":
      return { id: event.payload.confirmationId, kind: "state", content: `Awaiting approval for ${event.payload.toolId}`, createdAt, taskId: event.correlationId };
    default:
      return null;
  }
}