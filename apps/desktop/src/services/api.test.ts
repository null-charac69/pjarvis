import { describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/services/api";
import { clearBrowserSession } from "@/services/deployment";
import { backendHealth, sampleTool } from "@/test/fixtures";

describe("REST client", () => {
  it("sends credential-free requests and parses successful API envelopes", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: backendHealth, requestId: "request-1" }),
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.health()).resolves.toEqual(backendHealth);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/health$/),
      expect.objectContaining({ credentials: "omit", headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
  });

  it("turns backend HTTP failures into ApiError with a safe detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ detail: "Service unavailable" }),
    } as Response)));

    await expect(api.health()).rejects.toMatchObject({ status: 503, message: "Service unavailable" });
  });

  it("reports a local backend network failure without leaking fetch internals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("socket details"); }));

    await expect(api.health()).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
      code: "backend_offline",
      message: "The local backend could not be reached.",
    });
  });

  it("validates backend tool manifests before exposing them to the renderer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [sampleTool], requestId: "request-2" }),
    } as Response)));

    await expect(api.listTools()).resolves.toEqual([sampleTool]);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ ...sampleTool, manifest: { ...sampleTool.manifest, risk_level: "UNKNOWN" } }], requestId: "request-3" }),
    } as Response)));

    await expect(api.listTools()).rejects.toThrow();
  });

  it("bootstraps a no-store in-memory session and sends its token only in the REST header", async () => {
    vi.stubEnv("VITE_DEPLOYMENT_MODE", "browser");
    clearBrowserSession();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/session/token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { token: "short-lived-session-token", expiresAt: new Date(Date.now() + 60_000).toISOString() }, requestId: "session-1" }),
        } as Response;
      }
      void init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: backendHealth, requestId: "request-1" }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.health()).resolves.toEqual(backendHealth);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [sessionUrl, sessionInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(sessionUrl)).toContain("/api/v1/session/token");
    expect(sessionInit).toMatchObject({ cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    const [apiUrl, apiInit] = fetchMock.mock.calls[1] ?? [];
    expect(String(apiUrl)).toMatch(/\/api\/v1\/health$/);
    expect(apiInit?.headers).toMatchObject({ "X-Jarvis-Session-Token": "short-lived-session-token" });
    expect(String(apiUrl)).not.toContain("short-lived-session-token");
    expect(localStorage.length).toBe(0);
    clearBrowserSession();
    vi.unstubAllEnvs();
  });
});