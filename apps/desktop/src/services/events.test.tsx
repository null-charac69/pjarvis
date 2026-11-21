import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEventStream } from "@/hooks/useEventStream";
import { backendKeys } from "@/hooks/useBackend";
import { taskKeys } from "@/hooks/useTasks";
import { toolKeys } from "@/hooks/useTools";
import { BackendEventStream } from "@/services/events";
import { useAppStore } from "@/state/app-store";
import { installMockWebSocket, MockWebSocket } from "@/test/fixtures";
import type { JarvisEvent } from "@/types/contracts";

const event: JarvisEvent = {
  schemaVersion: 1,
  eventId: "11111111-1111-4111-8111-111111111111",
  occurredAt: "2026-10-06T12:00:00.000Z",
  correlationId: "22222222-2222-4222-8222-222222222222",
  type: "assistant.state.changed",
  payload: { state: "thinking" },
};

beforeEach(() => {
  vi.useFakeTimers();
  installMockWebSocket();
});

afterEach(() => vi.useRealTimers());

describe("backend WebSocket event stream", () => {
  it("connects to the development proxy, validates events, and ignores malformed or unknown frames", async () => {
    const received: JarvisEvent[] = [];
    const states: string[] = [];
    const stream = new BackendEventStream((message) => received.push(message), (state) => states.push(state));
    await stream.connect();
    const socket = MockWebSocket.instances[0];

    expect(socket.url).toBe(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/events`);
    socket.open();
    socket.message(JSON.stringify(event));
    socket.message(JSON.stringify({ ...event, type: "voice.transcript.unknown" }));
    socket.message("not-json");

    expect(received).toEqual([event]);
    expect(socket.sent).toContain('{"type":"ping"}');
    expect(states).toEqual(["connecting", "connected"]);
    stream.close();
  });

  it("reconnects after disconnect and bounds exponential retry delay at 30 seconds", async () => {
    const stream = new BackendEventStream(() => undefined, () => undefined);
    await stream.connect();
    const delays = [750, 1_500, 3_000, 6_000, 12_000, 24_000, 30_000, 30_000];

    for (let index = 0; index < delays.length; index += 1) {
      MockWebSocket.instances.at(-1)?.close();
      await vi.advanceTimersByTimeAsync(delays[index]);
      expect(MockWebSocket.instances).toHaveLength(index + 2);
    }

    stream.close();
    MockWebSocket.instances.at(-1)?.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockWebSocket.instances).toHaveLength(delays.length + 1);
  });

  it("resynchronizes health, task history/detail, and tools every time the stream reconnects", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    const taskId = "33333333-3333-4333-8333-333333333333";
    useAppStore.setState({ activeTaskId: taskId });
    function Harness() { useEventStream(); return null; }

    render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    await act(async () => MockWebSocket.instances[0].open());

    expect(invalidate).toHaveBeenCalledWith({ queryKey: backendKeys.health });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: backendKeys.llmHealth });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: taskKeys.history });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: taskKeys.detail(taskId) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: toolKeys.all });

    MockWebSocket.instances[0].close();
    await vi.advanceTimersByTimeAsync(750);
    await act(async () => MockWebSocket.instances[1].open());
    expect(invalidate).toHaveBeenCalledTimes(10);

    MockWebSocket.instances[1].message(JSON.stringify({
      ...event,
      eventId: "44444444-4444-4444-8444-444444444444",
      type: "provider.health.changed",
      payload: { provider: "llm", status: "healthy" },
    }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: backendKeys.llmHealth });
  });

  it("sends browser session authentication before the first ping", async () => {
    vi.stubEnv("VITE_DEPLOYMENT_MODE", "browser");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { token: "browser-ws-token", expiresAt: new Date(Date.now() + 60_000).toISOString() }, requestId: "session-1" }),
    } as Response)));
    const stream = new BackendEventStream(() => undefined, () => undefined);
    await stream.connect();
    const socket = MockWebSocket.instances[0];

    await act(async () => {
      socket.open();
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });
    expect(socket.sent[0]).toBe(JSON.stringify({ type: "authenticate", token: "browser-ws-token" }));
    expect(socket.sent[1]).toBe(JSON.stringify({ type: "ping" }));
    stream.close();
    vi.unstubAllEnvs();
  });
});