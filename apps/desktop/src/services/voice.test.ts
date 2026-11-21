import { describe, expect, it, vi } from "vitest";
import { directoryPickerOutcome, directoryPickerSupported, isEditableTarget, loadBrowserShortcutPreferences, matchesBrowserVoiceShortcut, saveBrowserShortcutPreferences, supportedRecorderMimeType, validateBrowserRecording } from "@/services/browser-voice";
import { encodePcmWav, enumerateAudioInputs, joinPcmChunks, resampleToPcm16, rootMeanSquare, safeVoiceError, selectLocalSpeechVoice, supportsVoiceCapture } from "@/services/voice";

describe("voice capture helpers", () => {
  it("selects a browser recording type accepted by the secured backend", () => {
    expect(supportedRecorderMimeType({ isTypeSupported: (type) => type.startsWith("audio/ogg") })).toBe("audio/ogg;codecs=opus");
    expect(supportedRecorderMimeType({ isTypeSupported: () => false })).toBeNull();
    expect(supportedRecorderMimeType(undefined)).toBeNull();
  });

  it("rejects empty, oversized, and unsupported browser audio", () => {
    expect(validateBrowserRecording(new Blob([], { type: "audio/webm" }))).toContain("empty");
    expect(validateBrowserRecording(new Blob([new Uint8Array(5)], { type: "audio/webm" }), 4)).toContain("size");
    expect(validateBrowserRecording(new Blob(["x"], { type: "application/octet-stream" }))).toContain("unsupported");
    expect(validateBrowserRecording(new Blob(["x"], { type: "audio/webm;codecs=opus" }))).toBeNull();
  });

  it("ignores voice shortcuts in editable controls and rejects shortcut collisions", () => {
    const input = document.createElement("input");
    const keyEvent = (overrides: Partial<KeyboardEvent> = {}) => ({ code: "Space", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, ...overrides }) as KeyboardEvent;
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(document.createElement("button"))).toBe(false);
    expect(matchesBrowserVoiceShortcut(keyEvent(), "Ctrl+Space")).toBe(true);
    expect(matchesBrowserVoiceShortcut(keyEvent({ shiftKey: true }), "Ctrl+Space")).toBe(false);
    expect(matchesBrowserVoiceShortcut(keyEvent({ code: "KeyK", key: "k" }), "Ctrl+Space")).toBe(false);
  });

  it("persists only a validated in-page shortcut preference", () => {
    localStorage.clear();
    expect(loadBrowserShortcutPreferences()).toEqual({ enabled: true, shortcut: "Ctrl+Space" });
    saveBrowserShortcutPreferences({ enabled: false, shortcut: "Alt+Shift+Space" });
    expect(loadBrowserShortcutPreferences()).toEqual({ enabled: false, shortcut: "Alt+Shift+Space" });
    expect(localStorage.length).toBe(1);
    expect(loadBrowserShortcutPreferences().shortcut).not.toBe("Ctrl+K");
  });

  it("classifies directory picker availability without granting filesystem access", () => {
    expect(directoryPickerSupported(undefined)).toBe(false);
    expect(directoryPickerSupported(() => undefined)).toBe(true);
    expect(directoryPickerOutcome(new DOMException("cancel", "AbortError"))).toBe("cancelled");
    expect(directoryPickerOutcome(new DOMException("denied", "NotAllowedError"))).toBe("not_allowed");
    expect(directoryPickerOutcome(new DOMException("blocked", "SecurityError"))).toBe("blocked_or_unavailable");
  });

  it("calculates the actual RMS level and handles empty buffers", () => {
    expect(rootMeanSquare(new Float32Array([0, 0]))).toBe(0);
    expect(rootMeanSquare(new Float32Array([1, -1]))).toBe(1);
  });

  it("resamples actual float input to signed 16-bit mono frames", () => {
    expect([...resampleToPcm16(new Float32Array([0, 0.25, -0.25, 1, -1, 0]), 48_000)])
      .toEqual([0, 32767]);
  });

  it("encodes joined PCM samples as a valid mono 16 kHz WAV", async () => {
    const audio = encodePcmWav(joinPcmChunks([new Int16Array([1]), new Int16Array([-2])]));
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
        else reject(new Error("WAV data was not returned as an ArrayBuffer."));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(audio);
    });

    expect(audio.type).toBe("audio/wav");
    expect(bytes.length).toBe(48);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WAVE");
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(16_000);
    expect(new DataView(bytes.buffer).getInt16(44, true)).toBe(1);
    expect(new DataView(bytes.buffer).getInt16(46, true)).toBe(-2);
  });

  it("lists only audio inputs without requesting microphone permission", async () => {
    const enumerateDevices = vi.fn(async () => [
      { kind: "audioinput", deviceId: "mic-1", label: "Desk microphone" },
      { kind: "audiooutput", deviceId: "speaker-1", label: "Speakers" },
    ] as MediaDeviceInfo[]);
    vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices } });

    await expect(enumerateAudioInputs()).resolves.toEqual([
      { deviceId: "mic-1", label: "Desk microphone" },
    ]);
    expect(enumerateDevices).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("reports missing capture support and safe permission errors", () => {
    expect(supportsVoiceCapture()).toBe(false);
    expect(safeVoiceError(new DOMException("denied", "NotAllowedError"))).toContain("permission");
  });

  it("selects a matching installed local speech voice and never a remote voice", () => {
    const remoteVoice = { lang: "en-IN", localService: false } as SpeechSynthesisVoice;
    const localFallback = { lang: "en-US", localService: true } as SpeechSynthesisVoice;
    const localMatch = { lang: "en-IN", localService: true } as SpeechSynthesisVoice;

    expect(selectLocalSpeechVoice([remoteVoice, localFallback, localMatch], "en-IN")).toBe(localMatch);
    expect(selectLocalSpeechVoice([remoteVoice, localFallback], "fr-FR")).toBe(localFallback);
    expect(selectLocalSpeechVoice([remoteVoice], "en-IN")).toBeUndefined();
  });
});