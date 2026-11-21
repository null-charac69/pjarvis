import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useBackend", () => ({
  useBackendHealth: () => ({ data: { status: "healthy" }, isError: false, refetch: vi.fn() }),
  useLlmHealth: () => ({ data: { status: "unconfigured" }, refetch: vi.fn() }),
}));
vi.mock("@/services/api", () => ({ api: { voiceHealth: vi.fn() } }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: readonly unknown[] }) => {
    const key = options.queryKey ?? [];
    if (key[0] === "runtime-provider-status") return { data: { restartRequired: false, providers: { llm: "mock", stt: "mock", tts: "mock", search: "unconfigured", weather: "external" } }, refetch: vi.fn() };
    if (key[0] === "tools") return { data: [], refetch: vi.fn() };
    if (key[0] === "permissions" || key[0] === "audit") return { data: [], refetch: vi.fn() };
    return { data: { stt: { status: "unconfigured", message: "not configured" }, wakeWord: { status: "unconfigured", message: "not configured" } }, refetch: vi.fn() };
  },
}));

import { ManagedDeviceValidationPage } from "@/pages/ManagedDeviceValidationPage";

describe("managed device validation page", () => {
  it("renders all 22 evidence-backed checks and the progressive setup flow", () => {
    render(<MemoryRouter><ManagedDeviceValidationPage /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "Managed Device Setup" })).toBeVisible();
    expect(screen.getByText("22 checks")).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Setup steps" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Browser and backend" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeVisible();
    expect(screen.queryByLabelText(/validation status/i)).not.toBeInTheDocument();
    expect(screen.getByText(/secrets are never requested or stored/i)).toBeVisible();
  });
});
