import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/app/App";
import { router } from "@/app/routes";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { ToolTestDialog } from "@/components/ToolTestDialog";
import { Providers } from "@/app/Providers";
import { defaultDesktopPreferences, type DesktopBridge } from "../../electron/contracts";
import { useAppStore } from "@/state/app-store";
import { installApiFetch, installMockWebSocket, runningTask, sampleAuditRecord, sampleTool } from "@/test/fixtures";

const taskId = runningTask.taskId;

beforeEach(async () => {
  await router.navigate("/");
  installApiFetch();
  installMockWebSocket();
  useAppStore.setState({
    assistantState: "idle", backendConnected: false, eventConnection: "disconnected",
    voiceLevel: 0, voiceShortcutRequest: 0,
    activeTaskId: null, activeCommandId: null, latestTask: null, pendingConfirmation: null,
    events: [], timeline: [], notifications: [], appError: null, preferencesLoaded: false,
    preferences: defaultDesktopPreferences,
  });
});

function assistantConfirmation() {
  useAppStore.setState({ pendingConfirmation: {
    mode: "assistant",
    commandId: runningTask.commandId,
    taskId,
    confirmationId: "88888888-8888-4888-8888-888888888888",
    toolId: "workspace.write",
    riskLevel: "HIGH",
    scopes: ["filesystem.write"],
    arguments: { path: "<masked>" },
    resources: ["workspace:approved"],
  } });
}

describe("permissions and task workflows", () => {
  it.each([
    ["Approve once", "approved_once"],
    ["Approve for session", "approved_session"],
    ["Deny", "denied"],
  ] as const)("sends %s decisions to the assistant backend", async (label, decision) => {
    const { calls } = installApiFetch();
    assistantConfirmation();
    render(<Providers><ConfirmationDialog /></Providers>);

    expect(screen.getByText("workspace:approved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
    await waitFor(() => expect(useAppStore.getState().pendingConfirmation).toBeNull());
    expect(calls).toContainEqual(expect.objectContaining({
      url: `/api/v1/assistant/commands/${runningTask.commandId}/confirmation`,
      method: "POST",
      body: JSON.stringify({ decision }),
    }));
  });

  it("keeps keyboard focus inside a pending permission dialog", async () => {
    assistantConfirmation();
    render(<QueryClientProvider client={new QueryClient()}>
      <><button>Outside action</button><ConfirmationDialog /></>
    </QueryClientProvider>);
    const dialog = screen.getByRole("dialog", { name: "Review this action" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    screen.getByText("Outside action").closest("button")?.focus();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    expect(dialog).toBeInTheDocument();
  });

  it("forwards task cancellation to the backend", async () => {
    const { calls } = installApiFetch((call) => {
      if (call.url === "/api/v1/assistant/history") return { data: [runningTask] };
      if (call.url === `/api/v1/tasks/${taskId}/cancel`) return { data: { ...runningTask, status: "cancelled", state: "cancelled" } };
      return undefined;
    });
    render(<App />);
    await router.navigate("/tasks");
    fireEvent.click(await screen.findByRole(
      "button",
      { name: `Cancel task ${taskId}` },
      { timeout: 10_000 },
    ));
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      url: `/api/v1/tasks/${taskId}/cancel`, method: "POST",
    })));
  });
});

describe("tools and page controls", () => {
  it("enables and disables a tool through the backend endpoint", async () => {
    const { calls } = installApiFetch();
    render(<App />);
    await router.navigate("/tools");
    const enabled = await screen.findByRole("checkbox");
    expect(enabled).toBeChecked();
    fireEvent.click(enabled);
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      url: `/api/v1/tools/${sampleTool.manifest.tool_id}/enabled`,
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    })));
  });

  it("rejects tool arguments that violate the backend JSON Schema before execution", async () => {
    const { calls } = installApiFetch();
    render(<Providers><ToolTestDialog tool={sampleTool} onClose={() => undefined} /></Providers>);
    fireEvent.change(await screen.findByRole("spinbutton"), { target: { value: "-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Test tool" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/must be >= 1/);
    expect(calls.some((call) => call.url.endsWith("/execute"))).toBe(false);
  });

  it("contains keyboard focus in the tool test dialog and closes through its explicit action", async () => {
    const onClose = vi.fn();
    render(<Providers><><button>Outside tool action</button><ToolTestDialog tool={sampleTool} onClose={onClose} /></></Providers>);
    const dialog = await screen.findByRole("dialog", { name: `Test ${sampleTool.manifest.display_name}` });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    screen.getByText("Outside tool action").closest("button")?.focus();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("filters audit records using backend-returned fields", async () => {
    const other = { ...sampleAuditRecord, id: "99999999-9999-4999-8999-999999999999", tool_id: "workspace.read", outcome: "denied", action: "read" };
    installApiFetch((call) => call.url === "/api/v1/audit" ? { data: [sampleAuditRecord, other] } : undefined);
    render(<App />);
    await router.navigate("/audit");
    expect(await screen.findByText("system.health")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter audit records" }), { target: { value: "workspace.read" } });
    expect(await screen.findByText("workspace.read")).toBeInTheDocument();
    expect(screen.queryByText("system.health")).not.toBeInTheDocument();
  });

  it("applies validated settings locally and saves onboarding completion for resume", async () => {
    const saved = { ...defaultDesktopPreferences };
    const bridge: DesktopBridge = {
      isElectron: true,
      getBackendBaseUrl: async () => "http://localhost:8765",
      getPreferences: async () => ({ ...saved }),
      savePreferences: async (patch) => Object.assign(saved, patch),
      openExternal: async () => true,
      minimizeWindow: () => undefined,
      toggleMaximizeWindow: () => undefined,
      closeWindow: () => undefined,
      onMaximizedChange: () => () => undefined,
      onVoiceShortcut: () => () => undefined,
    };
    vi.stubGlobal("jarvis", bridge);
    const { unmount } = render(<App />);
    await router.navigate("/settings");
    fireEvent.change(await screen.findByRole("combobox", { name: "Theme" }), { target: { value: "light" } });
    await waitFor(() => expect(useAppStore.getState().preferences.theme).toBe("light"));
    expect(document.documentElement.dataset.theme).toBe("light");

    await router.navigate("/onboarding");
    fireEvent.click(await screen.findByRole("button", { name: /Mark setup reviewed/ }));
    await waitFor(() => expect(useAppStore.getState().preferences.onboardingComplete).toBe(true));
    expect(saved.onboardingStep).toBe(5);
    expect(await screen.findByText("Setup review complete")).toBeInTheDocument();

    unmount();
    await router.navigate("/");
    render(<App />);
    await router.navigate("/onboarding");
    expect(await screen.findByText("Setup review complete")).toBeInTheDocument();
  });

  it("creates, reads, and clears session notifications from backend events", async () => {
    useAppStore.getState().pushEvent({
      schemaVersion: 1,
      eventId: "11111111-1111-4111-8111-111111111111",
      occurredAt: "2026-10-06T12:00:00.000Z",
      correlationId: "22222222-2222-4222-8222-222222222222",
      type: "notification.created",
      payload: { notificationId: "33333333-3333-4333-8333-333333333333", severity: "warning", title: "Disk space is low" },
    });
    render(<App />);
    await router.navigate("/notifications");
    expect(await screen.findByRole("heading", { level: 1, name: "Notifications" })).toBeInTheDocument();
    expect(await screen.findAllByText("Disk space is low")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Clear session" }));
    expect(await screen.findByText("No notifications")).toBeInTheDocument();
  });

  it("does not offer memory deletion while the backend memory contract is unavailable", async () => {
    render(<App />);
    await router.navigate("/memory");
    expect(await screen.findByText("No memory service is connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete memory/i })).not.toBeInTheDocument();
  });
});