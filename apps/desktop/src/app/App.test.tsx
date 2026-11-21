import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "@/app/App";
import { router } from "@/app/routes";
import { saveBrowserPreferences } from "@/services/browser-preferences";
import { useAppStore } from "@/state/app-store";
import { installApiFetch, installMockWebSocket, MockWebSocket, runtimeConfiguration, runtimeProviderStatus } from "@/test/fixtures";
import { defaultDesktopPreferences } from "../../electron/contracts";

const routes = [
  ["/", "Command center"],
  ["/conversation", "Conversations"],
  ["/tasks", "Task queue"],
  ["/tools", "Tools & skills"],
  ["/memory", "Memory"],
  ["/files", "Files & knowledge"],
  ["/system", "System monitor"],
  ["/capabilities", "Browser capabilities"],
  ["/audit", "Audit log"],
  ["/settings", "Settings"],
  ["/settings/deployment/validation", "Managed Device Setup"],
  ["/notifications", "Notifications"],
  ["/onboarding", "Welcome to Jarvis"],
] as const;

async function openRoute(path: string) {
  const view = render(<App />);
  await router.navigate(path);
  return view;
}

describe("Phase 5 application shell and routes", () => {
  beforeEach(async () => {
    await router.navigate("/");
    localStorage.removeItem("jarvis.browserPreferences.v1");
    installApiFetch();
    installMockWebSocket();
    useAppStore.setState({
      assistantState: "idle", backendConnected: false, eventConnection: "disconnected",
      activeTaskId: null, activeCommandId: null, latestTask: null, pendingConfirmation: null,
      events: [], timeline: [], notifications: [], appError: null,
      preferencesLoaded: false,
    });
  });

  it.each(routes)("loads route %s with the %s page heading", async (path, heading) => {
    await openRoute(path);
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
  });

  it("renders the navigation rail, top status bar, and right activity panel", async () => {
    await openRoute("/");
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeInTheDocument();
    expect(await screen.findByText("Backend online")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Activity" }).closest("aside")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide activity panel" })).toBeInTheDocument();
    expect((window as Window & { require?: unknown }).require).toBeUndefined();
  });

  it("renders backend system metrics and assistant states without synthetic samples", async () => {
    useAppStore.setState({ assistantState: "awaiting_confirmation" });
    useAppStore.getState().pushEvent({
      schemaVersion: 1,
      eventId: "11111111-1111-4111-8111-111111111111",
      occurredAt: "2026-10-06T12:00:00.000Z",
      correlationId: "22222222-2222-4222-8222-222222222222",
      type: "system.metric.updated",
      payload: { metric: "cpu_percent", value: 23.5, unit: "%" },
    });
    await openRoute("/system");
    expect(await screen.findByText("cpu_percent")).toBeInTheDocument();
    expect(screen.getByText("CPU, memory, and disk are sampled on request")).toBeInTheDocument();
    expect(useAppStore.getState().assistantState).toBe("awaiting_confirmation");
  });

  it("submits a development command through the REST client and records the result", async () => {
    const { calls } = installApiFetch();
    await openRoute("/");
    const command = screen.getByRole("textbox", { name: "Enter a command" });
    fireEvent.change(command, { target: { value: "Check local readiness" } });
    fireEvent.click(screen.getByRole("button", { name: "Send command" }));

    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      url: "/api/v1/assistant/commands",
      method: "POST",
    })));
    expect(await screen.findByText("The local service is ready.")).toBeInTheDocument();
  });

  it("shows the backend-unavailable state instead of simulated readiness", async () => {
    installApiFetch((call) => call.url === "/api/v1/health" ? { data: { detail: "offline" }, status: 503 } : undefined);
    await openRoute("/");
    await waitFor(() => expect(screen.getByText("Backend not responding")).toBeInTheDocument(), { timeout: 5_000 });
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("exposes deployment status and System Capabilities from Settings", async () => {
    await openRoute("/settings");
    expect(await screen.findByRole("heading", { name: "Deployment" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "System Capabilities" })).toHaveAttribute("href", "#/capabilities");
    expect(screen.getByText("Organization policy")).toBeInTheDocument();
  });

  it("asks the LLM configuration question only after progressing to its wizard step", async () => {
    let rolledBack = false;
    const current = {
      ...runtimeConfiguration,
      restartRequired: true,
      configuration: {
        ...runtimeConfiguration.configuration,
        weather: { ...runtimeConfiguration.configuration.weather, defaultLocation: "Current location" },
      },
    };
    const previous = {
      ...current,
      revision: "restored-revision",
      configuration: {
        ...current.configuration,
        weather: { ...current.configuration.weather, defaultLocation: "Restored location" },
      },
    };
    installApiFetch((call) => {
      if (call.url === "/api/v1/configuration" && call.method === "GET") {
        return { data: rolledBack ? previous : current };
      }
      if (call.url === "/api/v1/configuration/status" && call.method === "GET") {
        return { data: { ...runtimeProviderStatus, restartRequired: rolledBack } };
      }
      if (call.url === "/api/v1/configuration/rollback") {
        rolledBack = true;
        return { data: { rolledBack: true, revision: "restored-revision", restartRequired: true } };
      }
      return undefined;
    });
    await openRoute("/settings/deployment/validation");
    expect(await screen.findByRole("heading", { level: 1, name: "Managed Device Setup" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Which LLM do you want to use?" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Language model/ }));

    expect(await screen.findByRole("heading", { name: "Which LLM do you want to use?" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "local_openai_compatible" } });
    fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "environment" } });
    expect(screen.getByLabelText("Secret environment-variable name")).toHaveAttribute("placeholder", "JARVIS_LLM_API_KEY");
    fireEvent.click(await screen.findByRole("button", { name: /Weather location/ }));
    expect(await screen.findByLabelText("Default location")).toHaveValue("Current location");

    fireEvent.click(screen.getByRole("button", { name: "Rollback last save" }));

    await waitFor(() => expect(screen.getByLabelText("Default location")).toHaveValue("Restored location"));
    await waitFor(() => expect(screen.getAllByText("REQUIRES_RESTART").length).toBeGreaterThan(0));
  });

  it("labels backend-dependent memory and ingestion as unavailable", async () => {
    await openRoute("/memory");
    expect(await screen.findByText("No memory service is connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add memory/ })).toBeDisabled();

    await router.navigate("/files");
    expect(await screen.findByText("Ingestion & indexing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ingestion not configured/ })).toBeDisabled();
  });

  it("opens the command palette by keyboard and navigates with arrow keys", async () => {
    await openRoute("/");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search commands" }), { target: { value: "Audit log" } });
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Command palette" }), { key: "Enter" });
    expect(await screen.findByRole("heading", { level: 1, name: "Audit log" })).toBeInTheDocument();
  });

  it("applies reduced-motion preferences to the document", async () => {
    saveBrowserPreferences({ ...defaultDesktopPreferences, reducedMotion: true });
    await openRoute("/");
    await waitFor(() => expect(document.documentElement.dataset.motion).toBe("reduced"));
  });

  it("displays WebSocket connection state in the activity panel", async () => {
    const sockets = installMockWebSocket();
    await openRoute("/");
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    sockets[0].open();
    await waitFor(() => expect(useAppStore.getState().eventConnection).toBe("connected"));
    expect(screen.getByText("connected")).toBeInTheDocument();
    sockets[0].close();
    await waitFor(() => expect(useAppStore.getState().eventConnection).toBe("disconnected"));
    expect(screen.getByText("disconnected")).toBeInTheDocument();
    await waitFor(() => expect(sockets).toHaveLength(2), { timeout: 3_000 });
    sockets[1].open();
    await waitFor(() => expect(screen.getByText("connected")).toBeInTheDocument());
  });
});