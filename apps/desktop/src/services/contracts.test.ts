import { describe, expect, it } from "vitest";
import {
  DesktopPreferencesPatchSchema,
  DesktopPreferencesSchema,
  ExternalUrlSchema,
  defaultDesktopPreferences,
} from "../../electron/contracts";
import { backendEventSchema } from "@/types/contracts";

describe("desktop IPC contracts", () => {
  it("accepts complete local preferences and rejects unknown renderer fields", () => {
    expect(DesktopPreferencesSchema.parse(defaultDesktopPreferences)).toEqual(defaultDesktopPreferences);
    expect(() => DesktopPreferencesPatchSchema.parse({ theme: "dark", apiKey: "secret" })).toThrow();
  });

  it("allows credential-free HTTP(S) links and rejects unsafe schemes or credentials", () => {
    expect(ExternalUrlSchema.parse("https://example.com/path")).toBe("https://example.com/path");
    expect(() => ExternalUrlSchema.parse("file:///C:/secret.txt")).toThrow();
    expect(() => ExternalUrlSchema.parse("https://user:pass@example.com")).toThrow();
  });
});

describe("backend event contracts", () => {
  const base = {
    schemaVersion: 1,
    eventId: "eb9bb965-61d4-4655-83b2-52d85a1e581a",
    occurredAt: "2026-05-22T12:00:00Z",
    correlationId: "9dd27689-85ea-4151-b4d5-c83716f9f68a",
  };

  it("validates the camelCase typed event envelope", () => {
    expect(backendEventSchema.parse({
      ...base,
      type: "assistant.state.changed",
      payload: { state: "awaiting_confirmation" },
    })).toMatchObject({ type: "assistant.state.changed", payload: { state: "awaiting_confirmation" } });
  });

  it("accepts voice transcripts and playback metadata without audio payloads", () => {
    expect(backendEventSchema.parse({
      ...base,
      type: "voice.transcript.partial",
      payload: { text: "check system", sequence: 1 },
    })).toMatchObject({ type: "voice.transcript.partial", payload: { sequence: 1 } });
    expect(backendEventSchema.safeParse({
      ...base,
      type: "audio.playback.started",
      payload: { playbackId: "33333333-3333-4333-8333-333333333333", audio: "raw" },
    }).success).toBe(false);
  });

  it("accepts strict Phase 6 voice lifecycle and playback events", () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const playbackId = "44444444-4444-4444-8444-444444444444";
    const events = [
      ["voice.recording.started", { sessionId }],
      ["voice.recording.stopped", { sessionId, reason: "no_speech" }],
      ["voice.audio.level", { level: 0.25, durationMs: 1200 }],
      ["voice.speech.started", { sessionId }],
      ["voice.speech.ended", { sessionId, durationMs: 900 }],
      ["voice.transcription.failed", { sessionId, errorCode: "transcription_failed" }],
      ["audio.playback.progress", { playbackId, progress: 0.5, elapsedMs: 450 }],
      ["audio.playback.completed", { playbackId }],
      ["voice.provider.health.changed", { provider: "vad", status: "healthy" }],
    ] as const;

    for (const [type, payload] of events) {
      expect(backendEventSchema.parse({ ...base, type, payload })).toMatchObject({ type, payload });
    }
    expect(backendEventSchema.safeParse({
      ...base,
      type: "voice.audio.level",
      payload: { level: 1.1, durationMs: 100 },
    }).success).toBe(false);
  });

  it("rejects malformed identifiers and unknown event payload shapes", () => {
    expect(backendEventSchema.safeParse({
      ...base,
      eventId: "not-an-id",
      type: "assistant.state.changed",
      payload: { state: "awaiting_confirmation" },
    }).success).toBe(false);
    expect(backendEventSchema.safeParse({
      ...base,
      type: "permission.requested",
      payload: { confirmationId: "id", toolId: "system.health", riskLevel: "HIGH" },
    }).success).toBe(false);
  });
});