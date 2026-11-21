import { describe, expect, it } from "vitest";
import { browserNotificationDeliveryAllowed, safeBrowserNotification } from "@/services/browser-notifications";
import type { JarvisEvent } from "@/types/contracts";

const base = {
  schemaVersion: 1 as const,
  eventId: "11111111-1111-4111-8111-111111111111",
  occurredAt: "2026-10-08T12:00:00.000Z",
  correlationId: "22222222-2222-4222-8222-222222222222",
};

describe("safe browser notifications", () => {
  it("requires both an explicit enabled setting and granted browser permission", () => {
    expect(browserNotificationDeliveryAllowed(false, "granted")).toBe(false);
    expect(browserNotificationDeliveryAllowed(true, "default")).toBe(false);
    expect(browserNotificationDeliveryAllowed(true, "denied")).toBe(false);
    expect(browserNotificationDeliveryAllowed(true, "unsupported")).toBe(false);
    expect(browserNotificationDeliveryAllowed(true, "granted", "hidden")).toBe(false);
    expect(browserNotificationDeliveryAllowed(true, "granted")).toBe(true);
  });

  it("notifies for task completion and failure without task content", () => {
    const completed = { ...base, type: "task.updated", payload: { taskId: base.correlationId, status: "completed" } } as JarvisEvent;
    const failed = { ...base, type: "task.updated", payload: { taskId: base.correlationId, status: "failed" } } as JarvisEvent;
    expect(safeBrowserNotification(completed)).toEqual({ title: "Task completed", body: "A JARVIS task has completed." });
    expect(safeBrowserNotification(failed)?.body).not.toContain(base.correlationId);
  });

  it("notifies only generic permission and provider status, never arguments or transcript", () => {
    const permission = { ...base, type: "permission.requested", payload: { confirmationId: base.eventId, toolId: "workspace.read", riskLevel: "HIGH", transcript: "private text" } } as unknown as JarvisEvent;
    const outage = { ...base, type: "provider.health.changed", payload: { provider: "external-provider", status: "unavailable", secret: "never include" } } as unknown as JarvisEvent;
    expect(safeBrowserNotification(permission)).toEqual({ title: "Approval requested", body: "A JARVIS action is waiting for your review." });
    expect(safeBrowserNotification(outage)).toEqual({ title: "Provider unavailable", body: "A configured JARVIS provider needs attention." });
    expect(safeBrowserNotification(permission)?.body).not.toContain("private text");
    expect(safeBrowserNotification(outage)?.body).not.toContain("never include");
  });

  it("does not notify for unrelated or non-outage events", () => {
    const running = { ...base, type: "task.updated", payload: { taskId: base.correlationId, status: "running" } } as JarvisEvent;
    const healthy = { ...base, type: "provider.health.changed", payload: { provider: "local", status: "healthy" } } as JarvisEvent;
    expect(safeBrowserNotification(running)).toBeNull();
    expect(safeBrowserNotification(healthy)).toBeNull();
  });
});
