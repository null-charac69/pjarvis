import { useEffect, useRef, useState } from "react";
import { api } from "@/services/api";
import { encodePcmWav, enumerateAudioInputs, joinPcmChunks, resampleToPcm16, rootMeanSquare, safeVoiceError, selectLocalSpeechVoice, supportsVoiceCapture, type AudioInputDevice } from "@/services/voice";
import { useSubmitCommand } from "@/hooks/useAssistant";
import { useAppStore } from "@/state/app-store";
import { usePreferences } from "@/hooks/usePreferences";
import { isBrowserDeployment } from "@/services/deployment";
import { MAX_BROWSER_RECORDING_BYTES, supportedRecorderMimeType, validateBrowserRecording } from "@/services/browser-voice";
import type { AssistantState, VoiceEvent } from "@/types/contracts";

const SILENCE_MS = 1800;
const MAX_RECORDING_MS = 60_000;
const MAX_RECORDING_BYTES = 10 * 1024 * 1024;
const NO_SPEECH_TIMEOUT_MS = 10_000;
const MIN_SPEECH_MS = 250;

export function useVoice() {
  const submit = useSubmitCommand();
  const { preferences } = usePreferences();
  const setAssistantState = useAppStore((state) => state.setAssistantState);
  const setVoiceLevel = useAppStore((state) => state.setVoiceLevel);
  const activeTaskId = useAppStore((state) => state.activeTaskId);
  const latestTask = useAppStore((state) => state.latestTask);
  const pushEvent = useAppStore((state) => state.pushEvent);
  const voiceShortcutRequest = useAppStore((state) => state.voiceShortcutRequest);
  const [recording, setRecording] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const [wakeMonitoring, setWakeMonitoring] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [permission, setPermission] = useState<"unknown" | "granted" | "denied">("unknown");
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sttStatus, setSttStatus] = useState<"checking" | "healthy" | "unconfigured" | "unavailable" | "degraded">("checking");
  const browserDeployment = isBrowserDeployment();
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const captureSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const captureProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const browserAnalyserRef = useRef<AnalyserNode | null>(null);
  const browserRecorderRef = useRef<MediaRecorder | null>(null);
  const browserChunksRef = useRef<Blob[]>([]);
  const browserChunkBytesRef = useRef(0);
  const browserAudioErrorRef = useRef<string | null>(null);
  const browserFrameRef = useRef<number | null>(null);
  const browserLastVoiceAtRef = useRef(0);
  const browserHeardVoiceRef = useRef(false);
  const partialTimerRef = useRef<number | null>(null);
  const maxDurationTimerRef = useRef<number | null>(null);
  const chunksRef = useRef<Int16Array[]>([]);
  const byteCountRef = useRef(0);
  const sessionIdRef = useRef("");
  const sequenceRef = useRef(0);
  const partialInFlightRef = useRef(false);
  const activeRef = useRef(false);
  const captureRequestedRef = useRef(false);
  const startingRef = useRef(false);
  const lastVoiceAtRef = useRef(0);
  const recordingStartedAtRef = useRef(0);
  const speechCandidateAtRef = useRef(0);
  const speechStartedAtRef = useRef(0);
  const lastLevelEventAtRef = useRef(0);
  const noiseFloorRef = useRef(0.004);
  const heardVoiceRef = useRef(false);
  const startRef = useRef<() => Promise<void>>(async () => undefined);
  const stopRef = useRef<() => Promise<void>>(async () => undefined);
  const startWakeRef = useRef<() => Promise<void>>(async () => undefined);
  const stopWakeRef = useRef<() => Promise<void>>(async () => undefined);
  const wakeActiveRef = useRef(false);
  const wakeStartingRef = useRef(false);
  const wakeStreamRef = useRef<MediaStream | null>(null);
  const wakeContextRef = useRef<AudioContext | null>(null);
  const wakeSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const wakeProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const wakeResumeTimerRef = useRef<number | null>(null);
  const wakeSamplesRef = useRef<number[]>([]);
  const wakeVoicedRef = useRef(false);
  const wakeRequestRef = useRef(false);
  const wakeSessionIdRef = useRef("");
  const wakeLastDetectedAtRef = useRef(0);
  const lastSpokenMessageRef = useRef("");
  const playbackIdRef = useRef<string | null>(null);
  const lastShortcutRequestRef = useRef(0);
  const lastTtsHealthRef = useRef<"healthy" | "unconfigured" | "unavailable" | null>(null);

  async function refreshDevices() {
    try {
      setDevices(await enumerateAudioInputs());
    } catch {
      setDevices([]);
    }
  }

  function emitVoiceProviderHealth(provider: "stt" | "tts" | "vad" | "wake_word", status: "healthy" | "degraded" | "unavailable" | "unconfigured") {
    pushEvent({
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId: sessionIdRef.current || crypto.randomUUID(),
      type: "voice.provider.health.changed",
      payload: { provider, status },
    });
  }

  function emitVoiceEvent(type: VoiceEvent["type"], payload: VoiceEvent["payload"]) {
    pushEvent({
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId: sessionIdRef.current || crypto.randomUUID(),
      type,
      payload,
    } as VoiceEvent);
  }

  function updateAssistantState(state: AssistantState) {
    setAssistantState(state);
    pushEvent({
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId: sessionIdRef.current || crypto.randomUUID(),
      type: "assistant.state.changed",
      payload: { state },
    });
  }

  function emitPlayback(type: "audio.playback.started" | "audio.playback.stopped", playbackId: string, reason?: "completed" | "interrupted" | "cancelled" | "error") {
    const base = {
      schemaVersion: 1 as const,
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
    };
    if (type === "audio.playback.started") {
      pushEvent({ ...base, type, payload: { playbackId } });
    } else {
      pushEvent({ ...base, type, payload: { playbackId, reason: reason ?? "completed" } });
    }
  }

  function emitPlaybackProgress(playbackId: string, progress: number, elapsedMs: number) {
    pushEvent({
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId: sessionIdRef.current || crypto.randomUUID(),
      type: "audio.playback.progress",
      payload: { playbackId, progress: Math.min(1, Math.max(0, progress)), elapsedMs },
    });
  }

  function interruptSpeech(reason: "interrupted" | "cancelled" = "interrupted") {
    if (typeof window === "undefined" || !window.speechSynthesis || !playbackIdRef.current) return;
    window.speechSynthesis.cancel();
    emitPlayback("audio.playback.stopped", playbackIdRef.current, reason);
    playbackIdRef.current = null;
    setSpeaking(false);
    if (!activeRef.current) updateAssistantState("idle");
  }

  function speak(text: string) {
    if (!preferences.voiceOutputEnabled || !text.trim() || !("speechSynthesis" in window)) return;
    const availableVoices = window.speechSynthesis.getVoices().filter((voice) => voice.localService);
    const localVoice = availableVoices.find((voice) => voice.voiceURI === preferences.voiceOutputVoiceURI)
      ?? selectLocalSpeechVoice(availableVoices, preferences.language);
    if (!localVoice) {
      emitVoiceProviderHealth("tts", "unconfigured");
      setError("No installed local speech voice is available for the selected language.");
      return;
    }
    const beginPlayback = () => {
      void stopWakeMonitoring();
      interruptSpeech("interrupted");
      const playbackId = crypto.randomUUID();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = localVoice.lang || preferences.language;
      utterance.voice = localVoice;
      utterance.volume = preferences.voiceOutputVolume;
      utterance.rate = preferences.voiceOutputRate;
      playbackIdRef.current = playbackId;
      setSpeaking(true);
      updateAssistantState("speaking");
      emitPlayback("audio.playback.started", playbackId);
      const playbackStartedAt = Date.now();
      utterance.onboundary = (event) => {
        emitPlaybackProgress(playbackId, event.charIndex / Math.max(text.length, 1), Date.now() - playbackStartedAt);
      };
      utterance.onend = () => {
        if (playbackIdRef.current !== playbackId) return;
        emitPlaybackProgress(playbackId, 1, Date.now() - playbackStartedAt);
        pushEvent({
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          occurredAt: new Date().toISOString(),
          correlationId: sessionIdRef.current || crypto.randomUUID(),
          type: "audio.playback.completed",
          payload: { playbackId },
        });
        emitPlayback("audio.playback.stopped", playbackId, "completed");
        playbackIdRef.current = null;
        setSpeaking(false);
        updateAssistantState("completed");
      };
      utterance.onerror = () => {
        if (playbackIdRef.current !== playbackId) return;
        emitPlayback("audio.playback.stopped", playbackId, "error");
        playbackIdRef.current = null;
        setSpeaking(false);
        updateAssistantState("failed");
        setError("Speech playback failed. The text response is still available.");
      };
      window.speechSynthesis.speak(utterance);
    };
    if (activeRef.current || startingRef.current) {
      void stopRecording("cancelled").finally(beginPlayback);
    } else {
      beginPlayback();
    }
  }

  async function cleanupCapture() {
    if (partialTimerRef.current !== null) window.clearInterval(partialTimerRef.current);
    partialTimerRef.current = null;
    if (maxDurationTimerRef.current !== null) window.clearTimeout(maxDurationTimerRef.current);
    maxDurationTimerRef.current = null;
    captureProcessorRef.current?.disconnect();
    captureSourceRef.current?.disconnect();
    browserAnalyserRef.current?.disconnect();
    captureProcessorRef.current = null;
    captureSourceRef.current = null;
    browserAnalyserRef.current = null;
    if (browserFrameRef.current !== null) window.cancelAnimationFrame(browserFrameRef.current);
    browserFrameRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== "closed") await context.close();
    setVoiceLevel(0);
  }

  async function stopWakeMonitoring() {
    if (wakeResumeTimerRef.current !== null) window.clearTimeout(wakeResumeTimerRef.current);
    wakeResumeTimerRef.current = null;
    wakeActiveRef.current = false;
    wakeStartingRef.current = false;
    wakeProcessorRef.current?.disconnect();
    wakeSourceRef.current?.disconnect();
    wakeProcessorRef.current = null;
    wakeSourceRef.current = null;
    wakeStreamRef.current?.getTracks().forEach((track) => track.stop());
    wakeStreamRef.current = null;
    const context = wakeContextRef.current;
    wakeContextRef.current = null;
    if (context && context.state !== "closed") await context.close();
    wakeSamplesRef.current = [];
    wakeVoicedRef.current = false;
    setWakeMonitoring(false);
  }

  async function startWakeMonitoring() {
    if (browserDeployment && document.visibilityState !== "visible") return;
    if (wakeActiveRef.current || wakeStartingRef.current || activeRef.current || activeTaskId || speaking || !preferences.wakeWordEnabled) return;
    if (wakeResumeTimerRef.current !== null) window.clearTimeout(wakeResumeTimerRef.current);
    wakeResumeTimerRef.current = null;
    if (!supportsVoiceCapture()) {
      setError("This environment does not support microphone monitoring.");
      return;
    }
    if (!preferences.microphoneAllowed) {
      setError("Allow microphone access in Settings before enabling wake-word monitoring.");
      return;
    }
    wakeStartingRef.current = true;
    try {
      const health = await api.voiceHealth();
      if (health.wakeWord.status !== "healthy") {
        setError(health.wakeWord.message);
        return;
      }
      const audioConstraint: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(preferences.microphoneDeviceId ? { deviceId: { exact: preferences.microphoneDeviceId } } : {}),
      };
      if (!wakeStartingRef.current || !preferences.wakeWordEnabled || activeTaskId || activeRef.current || speaking) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false });
      if (!wakeStartingRef.current || !preferences.wakeWordEnabled || activeTaskId || activeRef.current || speaking) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      wakeStreamRef.current = stream;
      setPermission("granted");
      await refreshDevices();
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      wakeContextRef.current = context;
      wakeSourceRef.current = source;
      wakeProcessorRef.current = processor;
      wakeSamplesRef.current = [];
      wakeVoicedRef.current = false;
      wakeSessionIdRef.current = crypto.randomUUID();
      wakeActiveRef.current = true;
      setWakeMonitoring(true);
      processor.onaudioprocess = (event) => {
        event.outputBuffer.getChannelData(0).fill(0);
        if (!wakeActiveRef.current) return;
        const input = event.inputBuffer.getChannelData(0);
        if (rootMeanSquare(input) >= 0.018) wakeVoicedRef.current = true;
        if (wakeRequestRef.current) return;
        const pcm = resampleToPcm16(input, context.sampleRate);
        for (const sample of pcm) wakeSamplesRef.current.push(sample);
        if (wakeSamplesRef.current.length < 5120 || wakeRequestRef.current) return;
        const frame = Int16Array.from(wakeSamplesRef.current.splice(0, 5120));
        const containsVoice = wakeVoicedRef.current;
        wakeVoicedRef.current = false;
        if (!containsVoice) return;
        wakeRequestRef.current = true;
        const audio = new Blob([frame.buffer], { type: "application/octet-stream" });
        void api.detectWakeWord(audio, wakeSessionIdRef.current).then((result) => {
          const now = Date.now();
          if (!result.detected || now - wakeLastDetectedAtRef.current < 4000 || !wakeActiveRef.current) return;
          wakeLastDetectedAtRef.current = now;
          void stopWakeRef.current().then(() => startRef.current());
        }).catch((wakeError) => {
          if (wakeActiveRef.current) {
            setError(safeVoiceError(wakeError));
            void stopWakeRef.current().finally(() => resumeWakeMonitoring(5000));
          }
        }).finally(() => { wakeRequestRef.current = false; });
      };
      source.connect(processor);
      processor.connect(context.destination);
    } catch (wakeError) {
      await stopWakeMonitoring();
      setPermission(wakeError instanceof DOMException && wakeError.name === "NotAllowedError" ? "denied" : "unknown");
      setError(safeVoiceError(wakeError));
    } finally {
      wakeStartingRef.current = false;
    }
  }

  function resumeWakeMonitoring(delayMs = 600) {
    if (!preferences.wakeWordEnabled || (browserDeployment && document.visibilityState !== "visible")) return;
    if (wakeResumeTimerRef.current !== null) window.clearTimeout(wakeResumeTimerRef.current);
    wakeResumeTimerRef.current = window.setTimeout(() => {
      wakeResumeTimerRef.current = null;
      void startWakeRef.current();
    }, delayMs);
  }

  async function transcribePartial() {
    if (partialInFlightRef.current || chunksRef.current.length === 0 || !activeRef.current) return;
    const audio = encodePcmWav(joinPcmChunks(chunksRef.current));
    if (audio.size === 0) return;
    partialInFlightRef.current = true;
    const sequence = ++sequenceRef.current;
    try {
      const result = await api.transcribeVoice(audio, sessionIdRef.current, false, sequence);
      if (activeRef.current) setPartialTranscript(result.text);
    } catch (transcriptionError) {
      if (activeRef.current) setError(safeVoiceError(transcriptionError));
    } finally {
      partialInFlightRef.current = false;
    }
  }

  async function startBrowserRecording() {
    if (activeRef.current || startingRef.current || transcribing) return;
    if (!supportsVoiceCapture() || typeof MediaRecorder === "undefined") {
      setError("This browser does not support local microphone recording.");
      return;
    }
    if (!preferences.microphoneAllowed) {
      setError("Allow microphone access in Settings before starting voice input.");
      return;
    }
    if (speaking) interruptSpeech("interrupted");
    startingRef.current = true;
    captureRequestedRef.current = true;
    browserAudioErrorRef.current = null;
    browserChunksRef.current = [];
    browserChunkBytesRef.current = 0;
    browserHeardVoiceRef.current = false;
    setError(null);
    setPartialTranscript("");
    setDurationMs(0);
    sessionIdRef.current = crypto.randomUUID();
    sequenceRef.current = 0;
    recordingStartedAtRef.current = Date.now();
    try {
      const health = await api.voiceHealth();
      if (!captureRequestedRef.current) {
        startingRef.current = false;
        return;
      }
      setSttStatus(health.stt.status);
      if (health.stt.status !== "healthy") {
        setError(health.stt.status === "unconfigured"
          ? "Speech-to-text provider not configured."
          : "The configured speech-to-text provider is unavailable.");
        captureRequestedRef.current = false;
        startingRef.current = false;
        return;
      }
      const mimeType = supportedRecorderMimeType();
      if (!mimeType) throw new Error("This browser does not support an audio format accepted by the local backend.");
      const audioConstraint: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(preferences.microphoneDeviceId ? { deviceId: { exact: preferences.microphoneDeviceId } } : {}),
      };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false });
      if (!captureRequestedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        startingRef.current = false;
        return;
      }
      streamRef.current = stream;
      setPermission("granted");
      await refreshDevices();
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      audioContextRef.current = context;
      captureSourceRef.current = source;
      browserAnalyserRef.current = analyser;
      const recorder = new MediaRecorder(stream, { mimeType });
      browserRecorderRef.current = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (!event.data.size || browserRecorderRef.current !== recorder) return;
        browserChunkBytesRef.current += event.data.size;
        if (browserChunkBytesRef.current > MAX_BROWSER_RECORDING_BYTES) {
          browserAudioErrorRef.current = "The recording exceeded the allowed size.";
          void stopRecording("error");
          return;
        }
        browserChunksRef.current.push(event.data);
      });
      recorder.addEventListener("error", () => {
        browserAudioErrorRef.current = "Browser audio capture failed.";
        void stopRecording("error");
      }, { once: true });
      activeRef.current = true;
      startingRef.current = false;
      recorder.start(250);
      setRecording(true);
      updateAssistantState("listening");
      emitVoiceEvent("voice.recording.started", { sessionId: sessionIdRef.current });
      const samples = new Float32Array(analyser.fftSize);
      const monitor = () => {
        if (!activeRef.current) return;
        analyser.getFloatTimeDomainData(samples);
        const now = Date.now();
        const duration = now - recordingStartedAtRef.current;
        const level = rootMeanSquare(samples);
        setVoiceLevel(level);
        setDurationMs(duration);
        if (level >= 0.012) {
          browserHeardVoiceRef.current = true;
          browserLastVoiceAtRef.current = now;
        }
        if (browserHeardVoiceRef.current && now - browserLastVoiceAtRef.current >= preferences.voiceSilenceMs) {
          void stopRecording("completed");
          return;
        }
        if (!browserHeardVoiceRef.current && duration >= NO_SPEECH_TIMEOUT_MS) {
          void stopRecording("no_speech");
          return;
        }
        if (duration >= preferences.voiceMaxRecordingSeconds * 1000) {
          void stopRecording("timeout");
          return;
        }
        browserFrameRef.current = window.requestAnimationFrame(monitor);
      };
      browserFrameRef.current = window.requestAnimationFrame(monitor);
    } catch (captureError) {
      activeRef.current = false;
      captureRequestedRef.current = false;
      startingRef.current = false;
      setRecording(false);
      setPermission(captureError instanceof DOMException && captureError.name === "NotAllowedError" ? "denied" : "unknown");
      await cleanupCapture();
      updateAssistantState("idle");
      setError(safeVoiceError(captureError));
    }
  }

  async function startRecording() {
    if (browserDeployment) {
      await startBrowserRecording();
      return;
    }
    if (activeRef.current || startingRef.current || transcribing) return;
    if (!supportsVoiceCapture()) {
      setError("This environment does not support microphone recording.");
      return;
    }
    if (!preferences.microphoneAllowed) {
      setError("Allow microphone access in Settings before starting voice input.");
      return;
    }
    if (speaking) interruptSpeech("interrupted");
    if (wakeActiveRef.current) await stopWakeMonitoring();
    setError(null);
    startingRef.current = true;
    captureRequestedRef.current = true;
    setPartialTranscript("");
    chunksRef.current = [];
    byteCountRef.current = 0;
    sequenceRef.current = 0;
    sessionIdRef.current = crypto.randomUUID();
    recordingStartedAtRef.current = Date.now();
    speechCandidateAtRef.current = 0;
    speechStartedAtRef.current = 0;
    lastLevelEventAtRef.current = 0;
    noiseFloorRef.current = 0.004;
    setDurationMs(0);
    lastVoiceAtRef.current = 0;
    heardVoiceRef.current = false;
    try {
      const audioConstraint: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(preferences.microphoneDeviceId ? { deviceId: { exact: preferences.microphoneDeviceId } } : {}),
      };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false });
      if (!captureRequestedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        startingRef.current = false;
        return;
      }
      streamRef.current = stream;
      setPermission("granted");
      await refreshDevices();
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(context.destination);
      captureSourceRef.current = source;
      captureProcessorRef.current = processor;
      audioContextRef.current = context;
      processor.onaudioprocess = (event) => {
        const output = event.outputBuffer.getChannelData(0);
        output.fill(0);
        if (!activeRef.current) return;
        const input = event.inputBuffer.getChannelData(0);
        const level = rootMeanSquare(input);
        setVoiceLevel(level);
        const now = Date.now();
        const duration = now - recordingStartedAtRef.current;
        if (now - lastLevelEventAtRef.current >= 250) {
          lastLevelEventAtRef.current = now;
          emitVoiceEvent("voice.audio.level", {
            level: Math.min(1, Math.max(0, level)),
            durationMs: duration,
          });
        }
        setDurationMs(duration);
        const threshold = Math.max(0.012, noiseFloorRef.current * 3);
        if (level < threshold && speechStartedAtRef.current === 0) {
          noiseFloorRef.current = noiseFloorRef.current * 0.95 + level * 0.05;
        }
        if (level >= threshold) {
          if (speechCandidateAtRef.current === 0) speechCandidateAtRef.current = now;
          if (speechStartedAtRef.current === 0 && now - speechCandidateAtRef.current >= MIN_SPEECH_MS) {
            speechStartedAtRef.current = now;
            heardVoiceRef.current = true;
            lastVoiceAtRef.current = now;
            emitVoiceEvent("voice.speech.started", { sessionId: sessionIdRef.current });
          }
          if (heardVoiceRef.current) lastVoiceAtRef.current = now;
        } else {
          speechCandidateAtRef.current = 0;
        }
        if (!heardVoiceRef.current && duration >= NO_SPEECH_TIMEOUT_MS) {
          void stopRecording("no_speech");
          return;
        } else if (heardVoiceRef.current && now - lastVoiceAtRef.current >= SILENCE_MS) {
          if (speechStartedAtRef.current > 0) {
            emitVoiceEvent("voice.speech.ended", {
              sessionId: sessionIdRef.current,
              durationMs: now - speechStartedAtRef.current,
            });
            const speechDuration = now - speechStartedAtRef.current;
            speechStartedAtRef.current = 0;
            void stopRecording(speechDuration < MIN_SPEECH_MS ? "no_speech" : "completed");
            return;
          }
          void stopRecording("no_speech");
          return;
        }
        const samples = resampleToPcm16(input, context.sampleRate);
        chunksRef.current.push(samples);
        byteCountRef.current += samples.byteLength;
        if (byteCountRef.current > MAX_RECORDING_BYTES) void stopRef.current();
      };
      activeRef.current = true;
      startingRef.current = false;
      setRecording(true);
      updateAssistantState("listening");
      emitVoiceEvent("voice.recording.started", { sessionId: sessionIdRef.current });
      partialTimerRef.current = window.setInterval(() => void transcribePartial(), 2500);
      maxDurationTimerRef.current = window.setTimeout(() => {
        if (activeRef.current) void stopRecording("timeout");
      }, MAX_RECORDING_MS);
    } catch (captureError) {
      activeRef.current = false;
      captureRequestedRef.current = false;
      startingRef.current = false;
      setRecording(false);
      setPermission(captureError instanceof DOMException && captureError.name === "NotAllowedError" ? "denied" : "unknown");
      await cleanupCapture();
      updateAssistantState("idle");
      setError(safeVoiceError(captureError));
    }
  }

  async function cancelActiveTask() {
    if (activeRef.current || startingRef.current) await stopRecording("cancelled");
    if (playbackIdRef.current) interruptSpeech("cancelled");
    if (activeTaskId) await api.cancelTask(activeTaskId);
  }

  async function stopRecording(reason: "completed" | "cancelled" | "timeout" | "no_speech" | "error" = "completed") {
    if (browserDeployment) {
      captureRequestedRef.current = false;
      const recorder = browserRecorderRef.current;
      if (startingRef.current && !recorder) {
        startingRef.current = false;
        activeRef.current = false;
        return;
      }
      if (!activeRef.current || !recorder) return;
      activeRef.current = false;
      setRecording(false);
      setTranscribing(true);
      updateAssistantState("transcribing");
      const recordingDuration = Date.now() - recordingStartedAtRef.current;
      setDurationMs(recordingDuration);
      if (browserFrameRef.current !== null) window.cancelAnimationFrame(browserFrameRef.current);
      browserFrameRef.current = null;
      emitVoiceEvent("voice.recording.stopped", { sessionId: sessionIdRef.current, reason });
      const audio = await new Promise<Blob>((resolve) => {
        if (recorder.state === "inactive") {
          resolve(new Blob(browserChunksRef.current, { type: recorder.mimeType }));
          return;
        }
        recorder.addEventListener("stop", () => resolve(new Blob(browserChunksRef.current, { type: recorder.mimeType })), { once: true });
        recorder.stop();
      });
      await cleanupCapture();
      browserRecorderRef.current = null;
      browserChunksRef.current = [];
      browserChunkBytesRef.current = 0;
      const captureError = browserAudioErrorRef.current;
      browserAudioErrorRef.current = null;
      if (reason === "cancelled" || reason === "no_speech" || captureError) {
        setTranscribing(false);
        updateAssistantState(reason === "cancelled" || reason === "no_speech" ? "idle" : "failed");
        if (captureError) setError(captureError);
        else if (reason === "no_speech") setError("No speech was detected. Try again closer to the microphone.");
        resumeWakeMonitoring();
        return;
      }
      const audioError = validateBrowserRecording(audio);
      if (audioError) {
        setTranscribing(false);
        updateAssistantState("failed");
        setError(audioError);
        resumeWakeMonitoring();
        return;
      }
      try {
        const result = await api.transcribeVoice(audio, sessionIdRef.current, true, ++sequenceRef.current);
        const transcript = result.text.trim();
        setPartialTranscript(transcript);
        const command = transcript.toLocaleLowerCase().replace(/[.!?,]/g, "").trim();
        if (/^(jarvis\s+)?(stop|stop speaking)$/.test(command)) {
          interruptSpeech("interrupted");
        } else if (/^(jarvis\s+)?(cancel|cancel that)$/.test(command)) {
          if (playbackIdRef.current) interruptSpeech("cancelled");
          if (activeTaskId) await api.cancelTask(activeTaskId);
        } else if (transcript) {
          submit.mutate({ transcript });
        }
        setTranscribing(false);
        resumeWakeMonitoring();
      } catch (transcriptionError) {
        setTranscribing(false);
        updateAssistantState("failed");
        setError(safeVoiceError(transcriptionError));
        resumeWakeMonitoring();
      }
      return;
    }
    captureRequestedRef.current = false;
    if (!activeRef.current) return;
    activeRef.current = false;
    const recordingDuration = Date.now() - recordingStartedAtRef.current;
    setDurationMs(recordingDuration);
    if (speechStartedAtRef.current > 0) {
      emitVoiceEvent("voice.speech.ended", {
        sessionId: sessionIdRef.current,
        durationMs: Date.now() - speechStartedAtRef.current,
      });
      speechStartedAtRef.current = 0;
    }
    setRecording(false);
    setTranscribing(true);
    updateAssistantState("transcribing");
    if (partialTimerRef.current !== null) window.clearInterval(partialTimerRef.current);
    partialTimerRef.current = null;
    await cleanupCapture();
    emitVoiceEvent("voice.recording.stopped", { sessionId: sessionIdRef.current, reason });
    const audio = encodePcmWav(joinPcmChunks(chunksRef.current));
    chunksRef.current = [];
    byteCountRef.current = 0;
    if (audio.size === 0 || reason === "no_speech" || reason === "cancelled") {
      setTranscribing(false);
      updateAssistantState(reason === "cancelled" || reason === "no_speech" ? "idle" : "failed");
      if (reason === "no_speech") setError("No speech was detected. Try again closer to the microphone.");
      else if (reason !== "cancelled") setError("No audio was captured. Hold the microphone button while speaking.");
      resumeWakeMonitoring();
      return;
    }
    try {
      const result = await api.transcribeVoice(audio, sessionIdRef.current, true, ++sequenceRef.current);
      const transcript = result.text.trim();
      setPartialTranscript(transcript);
      const command = transcript.toLocaleLowerCase().replace(/[.!?,]/g, "").trim();
      if (/^(jarvis\s+)?(stop|stop speaking)$/.test(command)) {
        interruptSpeech("interrupted");
      } else if (/^(jarvis\s+)?(cancel|cancel that)$/.test(command)) {
        if (playbackIdRef.current) interruptSpeech("cancelled");
        if (activeTaskId) await api.cancelTask(activeTaskId);
      } else if (transcript) {
        submit.mutate({ transcript });
      }
      setTranscribing(false);
      resumeWakeMonitoring();
    } catch (transcriptionError) {
      setTranscribing(false);
      updateAssistantState("failed");
      setError(safeVoiceError(transcriptionError));
      resumeWakeMonitoring();
    }
  }

  startRef.current = startRecording;
  stopRef.current = stopRecording;
  startWakeRef.current = startWakeMonitoring;
  stopWakeRef.current = stopWakeMonitoring;

  useEffect(() => {
    if (!browserDeployment) return;
    let current = true;
    void api.voiceHealth().then((health) => {
      if (current) setSttStatus(health.stt.status);
    }).catch(() => {
      if (current) setSttStatus("unavailable");
    });
    return () => { current = false; };
  }, [browserDeployment]);

  useEffect(() => {
    emitVoiceProviderHealth("vad", "healthy");
  }, []);

  useEffect(() => {
    const updateTtsHealth = () => {
      const status = !("speechSynthesis" in window)
        ? "unavailable"
        : selectLocalSpeechVoice(window.speechSynthesis.getVoices(), preferences.language)
          ? "healthy"
          : "unconfigured";
      if (lastTtsHealthRef.current === status) return;
      lastTtsHealthRef.current = status;
      emitVoiceProviderHealth("tts", status);
    };
    updateTtsHealth();
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.addEventListener("voiceschanged", updateTtsHealth);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", updateTtsHealth);
  }, [preferences.language]);

  useEffect(() => {
    if (voiceShortcutRequest <= lastShortcutRequestRef.current) return;
    lastShortcutRequestRef.current = voiceShortcutRequest;
    if (activeRef.current) void stopRef.current();
    else void startRef.current();
  }, [voiceShortcutRequest]);

  useEffect(() => {
    if (!browserDeployment) return;
    const onStart = () => { void startRef.current(); };
    const onStop = () => { void stopRef.current(); };
    const onCancel = () => { void stopRecording("cancelled"); };
    window.addEventListener("jarvis-browser-ptt-start", onStart);
    window.addEventListener("jarvis-browser-ptt-stop", onStop);
    window.addEventListener("jarvis-browser-ptt-cancel", onCancel);
    return () => {
      window.removeEventListener("jarvis-browser-ptt-start", onStart);
      window.removeEventListener("jarvis-browser-ptt-stop", onStop);
      window.removeEventListener("jarvis-browser-ptt-cancel", onCancel);
    };
  }, [browserDeployment]);

  useEffect(() => {
    if (preferences.wakeWordEnabled && !activeTaskId && !recording && !transcribing && !speaking) {
      void startWakeRef.current();
    } else {
      void stopWakeRef.current();
    }
  }, [preferences.wakeWordEnabled, activeTaskId, recording, transcribing, speaking]);

  useEffect(() => {
    if (!browserDeployment) return;
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        if (wakeResumeTimerRef.current !== null) window.clearTimeout(wakeResumeTimerRef.current);
        wakeResumeTimerRef.current = null;
        wakeStartingRef.current = false;
        void stopWakeRef.current();
        if (activeRef.current || startingRef.current) void stopRecording("cancelled");
        return;
      }
      if (preferences.wakeWordEnabled && !activeTaskId && !recording && !transcribing && !speaking) {
        void startWakeRef.current();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [browserDeployment, preferences.wakeWordEnabled, activeTaskId, recording, transcribing, speaking]);

  useEffect(() => {
    const message = latestTask?.assistantMessage;
    if (!message || latestTask.status !== "completed" || message.messageId === lastSpokenMessageRef.current) return;
    lastSpokenMessageRef.current = message.messageId;
    speak(message.content);
  }, [latestTask, preferences.voiceOutputEnabled, preferences.language]);

  useEffect(() => () => {
    captureRequestedRef.current = false;
    activeRef.current = false;
    startingRef.current = false;
    const recorder = browserRecorderRef.current;
    browserRecorderRef.current = null;
    browserChunksRef.current = [];
    browserChunkBytesRef.current = 0;
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* The stream is stopped below regardless. */ }
    }
    void cleanupCapture();
    void stopWakeRef.current();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }, []);

  return {
    recording,
    wakeMonitoring,
    transcribing,
    speaking,
    permission,
    devices,
    partialTranscript,
    durationMs,
    error,
    startRecording,
    stopRecording,
    startWakeMonitoring,
    stopWakeMonitoring,
    refreshDevices,
    interruptSpeech,
    cancelActiveTask,
    speechToTextReady: !browserDeployment || sttStatus === "healthy",
    speechToTextStatus: sttStatus,
    voiceAvailable: supportsVoiceCapture() && (!browserDeployment || (sttStatus === "healthy" && supportedRecorderMimeType() !== null)),
  };
}