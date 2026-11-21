import type { JarvisEvent } from "@/types/contracts";

export type SafeBrowserNotification = { title: string; body: string };

export function browserNotificationDeliveryAllowed(
  enabled: boolean,
  permission: NotificationPermission | "unsupported",
  visibility: DocumentVisibilityState = "visible",
): boolean {
  return enabled && permission === "granted" && visibility === "visible";
}

export function safeBrowserNotification(event: JarvisEvent): SafeBrowserNotification | null {
  if (event.type === "task.updated") {
    if (event.payload.status === "completed") return { title: "Task completed", body: "A JARVIS task has completed." };
    if (event.payload.status === "failed") return { title: "Task failed", body: "A JARVIS task failed. Review it in the application." };
    return null;
  }
  if (event.type === "permission.requested") {
    return { title: "Approval requested", body: "A JARVIS action is waiting for your review." };
  }
  if (event.type === "provider.health.changed" || event.type === "voice.provider.health.changed") {
    if (event.payload.status === "unavailable" || event.payload.status === "degraded") {
      return { title: "Provider unavailable", body: "A configured JARVIS provider needs attention." };
    }
  }
  return null;
}
