import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: { voiceHealth: vi.fn(), transcribeVoice: vi.fn(), cancelTask: vi.fn(), detectWakeWord: vi.fn() },
  mutate: vi.fn(),
  latestTask: null as unknown,
  setAssistantState: vi.fn(),
  setVoiceLevel: vi.fn(),
  pushEvent: vi.fn(),
  preferences: {
    microphoneAllowed: true,
    microphoneDeviceId: "",
    wakeWordEnabled: false,
    voiceOutputEnabled: false,
    voiceOutputVoiceURI: "",
    voiceOutputVolume: 1,
    voiceOutputRate: 1,
    language: "en-US",
    voiceSilenceMs: 700,
    voiceMaxRecordingSeconds: 10,
  },
}));

vi.mock("@/services/api", () => ({ api: mocks.api }));
vi.mock("@/services/deployment", () => ({ isBrowserDeployment: () => true }));
vi.mock("@/hooks/useAssistant", () => ({ useSubmitCommand: () => ({ mutate: mocks.mutate }) }));
vi.mock("@/hooks/usePreferences", () => ({ usePreferences: () => ({ preferences: mocks.preferences }) }));
vi.mock("@/state/app-store", () => {
  const state = {
    activeTaskId: null,
    get latestTask() { return mocks.latestTask; },
    voiceShortcutRequest: 0,
    setAssistantState: mocks.setAssistantState,
    setVoiceLevel: mocks.setVoiceLevel,
    pushEvent: mocks.pushEvent,
  };
  return { useAppStore: (selector: (value: typeof state) => unknown) => selector(state) };
});

import { useVoice } from "@/hooks/useVoice";

class FakeStream {
  stopped = false;
  getTracks() { return [{ stop: () => { this.stopped = true; } }]; }
}

class FakeAudioContext {
  sampleRate = 48_000;
  state = "running";
  destination = {};
  createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
  createAnalyser() { return { fftSize: 1024, connect: vi.fn(), disconnect: vi.fn(), getFloatTimeDomainData: (samples: Float32Array) => samples.fill(analyserLevel) }; }
  async close() { this.state = "closed"; }
}

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported(type: string) { return type.startsWith("audio/webm"); }
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  constructor(_stream: MediaStream, _options: MediaRecorderOptions) { super(); }
  start() { this.state = "recording"; }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    const data = new Event("dataavailable");
    Object.defineProperty(data, "data", { value: new Blob(["audio"], { type: this.mimeType }) });
    this.dispatchEvent(data);
    this.dispatchEvent(new Event("stop"));
  }
}

class FakeSpeechSynthesisUtterance {
  lang = "";
  voice: SpeechSynthesisVoice | null = null;
  volume = 1;
  rate = 1;
  onboundary: ((event: SpeechSynthesisEvent) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

let getUserMedia: ReturnType<typeof vi.fn>;
let enumerateDevices: ReturnType<typeof vi.fn>;
let rafCallback: FrameRequestCallback | undefined;
let analyserLevel = 0;

function configureMedia(getMedia = vi.fn(async () => new FakeStream() as unknown as MediaStream)) {
  getUserMedia = getMedia;
  enumerateDevices = vi.fn(async () => []);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia, enumerateDevices },
  });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { rafCallback = callback; return 1; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
}

beforeEach(() => {
  vi.stubEnv("VITE_DEPLOYMENT_MODE", "browser");
  vi.stubEnv("MODE", "browser");
  mocks.api.voiceHealth.mockReset();
  mocks.api.transcribeVoice.mockReset();
  mocks.api.cancelTask.mockReset();
  mocks.api.detectWakeWord.mockReset();
  mocks.preferences.voiceSilenceMs = 700;
  mocks.preferences.voiceMaxRecordingSeconds = 10;
  mocks.preferences.voiceOutputEnabled = false;
  mocks.latestTask = null;
  mocks.api.voiceHealth.mockResolvedValue({ stt: { status: "healthy", message: "ready" }, wakeWord: { status: "unconfigured", message: "off" } });
  mocks.api.transcribeVoice.mockResolvedValue({ text: "Open the local dashboard" });
  mocks.api.cancelTask.mockResolvedValue(undefined);
  mocks.mutate.mockReset();
  mocks.setAssistantState.mockReset();
  mocks.setVoiceLevel.mockReset();
  mocks.pushEvent.mockReset();
  configureMedia();
  analyserLevel = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rafCallback = undefined;
});

describe("browser voice lifecycle", () => {
  it("captures in memory, uploads once to local STT, and submits through the command hook", async () => {
    const { result } = renderHook(() => useVoice());
    await act(async () => { await result.current.startRecording(); });
    expect(result.current.recording).toBe(true);
    expect(getUserMedia).toHaveBeenCalledOnce();
    await act(async () => { await result.current.stopRecording(); });
    expect(mocks.api.transcribeVoice).toHaveBeenCalledOnce();
    expect(mocks.api.transcribeVoice.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(mocks.api.transcribeVoice.mock.calls[0]?.[0].type).toContain("audio/webm");
    expect(mocks.mutate).toHaveBeenCalledWith({ transcript: "Open the local dashboard" });
  });

  it("does not prompt for a microphone when backend STT is unconfigured", async () => {
    mocks.api.voiceHealth.mockResolvedValue({ stt: { status: "unconfigured", message: "missing" }, wakeWord: { status: "unconfigured", message: "off" } });
    const { result } = renderHook(() => useVoice());
    await act(async () => { await result.current.startRecording(); });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.error).toBe("Speech-to-text provider not configured.");
    expect(result.current.speechToTextStatus).toBe("unconfigured");
  });

  it("cancels a pending provider health check before requesting microphone access", async () => {
    let resolveHealth: ((value: { stt: { status: string; message: string }; wakeWord: { status: string; message: string } }) => void) | undefined;
    mocks.api.voiceHealth.mockReturnValue(new Promise((resolve) => { resolveHealth = resolve; }));
    const { result } = renderHook(() => useVoice());
    let starting: Promise<void> | undefined;
    act(() => { starting = result.current.startRecording(); });
    await act(async () => { await result.current.stopRecording("cancelled"); });
    await act(async () => {
      resolveHealth?.({ stt: { status: "healthy", message: "ready" }, wakeWord: { status: "unconfigured", message: "off" } });
      await starting;
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.recording).toBe(false);
  });

  it("reports denied microphone permission and leaves typed command path available", async () => {
    configureMedia(vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }));
    const { result } = renderHook(() => useVoice());
    await act(async () => { await result.current.startRecording(); });
    expect(result.current.permission).toBe("denied");
    expect(result.current.error).toContain("Microphone access was denied");
    expect(result.current.recording).toBe(false);
  });

  it("reports a missing microphone without uploading audio", async () => {
    configureMedia(vi.fn(async () => { throw new DOMException("missing", "NotFoundError"); }));
    const { result } = renderHook(() => useVoice());
    await act(async () => { await result.current.startRecording(); });
    expect(result.current.error).toContain("No microphone is available");
    expect(mocks.api.transcribeVoice).not.toHaveBeenCalled();
  });

  it("stops and uploads once after the configured silence interval", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { result } = renderHook(() => useVoice());
    await act(async () => { await result.current.startRecording(); });
    analyserLevel = 0.03;
    await act(async () => { now = 1_100; rafCallback?.(now); });
    analyserLevel = 0;
    await act(async () => { now = 1_801; rafCallback?.(now); });
    expect(result.current.recording).toBe(false);
    expect(mocks.api.transcribeVoice).toHaveBeenCalledOnce();
  });

  it("enforces the configured maximum recording duration", async () => {
    let now = 1_000;
    mocks.preferences.voiceMaxRecordingSeconds = 5;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { result } = renderHook(() => useVoice());
    await act(async () => { await result.current.startRecording(); });
    await act(async () => { now = 6_001; rafCallback?.(now); });
    expect(result.current.recording).toBe(false);
    expect(mocks.api.transcribeVoice).toHaveBeenCalledOnce();
  });

  it("speaks with a browser-local voice and interrupts playback when capture starts", async () => {
    const localVoice = { voiceURI: "local-en", lang: "en-US", localService: true } as SpeechSynthesisVoice;
    const synthesis = {
      getVoices: () => [localVoice],
      cancel: vi.fn(),
      speak: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synthesis });
    vi.stubGlobal("SpeechSynthesisUtterance", FakeSpeechSynthesisUtterance);
    mocks.preferences.voiceOutputEnabled = true;
    const { result, rerender } = renderHook(() => useVoice());
    mocks.latestTask = { status: "completed", assistantMessage: { messageId: "reply-1", content: "A local spoken reply." } };
    rerender();
    expect(synthesis.speak).toHaveBeenCalledOnce();
    const utterance = synthesis.speak.mock.calls[0]?.[0] as FakeSpeechSynthesisUtterance;
    expect(utterance.voice?.voiceURI).toBe("local-en");
    expect(utterance.text).toBe("A local spoken reply.");
    await act(async () => { await result.current.startRecording(); });
    expect(synthesis.cancel).toHaveBeenCalledOnce();
    expect(result.current.recording).toBe(true);
    await act(async () => { await result.current.stopRecording("cancelled"); });
  });

  it("cancels recording without uploading buffered audio", async () => {
    const { result } = renderHook(() => useVoice());
    await act(async () => { await result.current.startRecording(); });
    await act(async () => { await result.current.stopRecording("cancelled"); });
    expect(mocks.api.transcribeVoice).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
