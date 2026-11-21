import { useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowRight, Check, CircleHelp, ExternalLink, FolderOpen, LoaderCircle, Mic, RotateCcw, ShieldCheck, Volume2 } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, PageHeading, Panel } from "@/components/ui";
import { useBackendHealth } from "@/hooks/useBackend";
import { assistantConfirmation } from "@/hooks/useConfirmations";
import { usePreferences } from "@/hooks/usePreferences";
import { useAppStore } from "@/state/app-store";
import { api } from "@/services/api";
import { browserCapabilityMatrix, deploymentMode, pwaInstallAvailability, requestPwaInstall, browserFeatures, PWA_INSTALL_UNDETERMINED_MESSAGE } from "@/services/deployment";
import { BROWSER_SHORTCUT_OPTIONS, directoryPickerOutcome, directoryPickerSupported, loadBrowserShortcutPreferences, saveBrowserShortcutPreferences, supportedRecorderMimeType, validateBrowserRecording } from "@/services/browser-voice";
import { buildInitialValidationChecks, EMPTY_SETUP_PROGRESS, guidanceForCheck, loadSetupProgress, providerStatusForCheck, readinessStatus, saveSetupProgress, stepForCheck, validationExport, WIZARD_STEPS, type BrowserSetupProgress, type EvidenceCode, type ValidationCheck, type ValidationStatus, type WizardStepId } from "@/services/managed-setup";
import type { RuntimeConfiguration, RuntimeConfigurationIssue, ToolListing } from "@/types/contracts";

const CHECK_LABELS: Record<string, string> = {
  voice_input: "Voice input", push_to_talk: "Push-to-talk", wake_word: "Wake word", tts: "Speech output",
  web_search: "Web search", weather: "Weather", webpage_retrieval: "Approved webpage retrieval",
  workspace_tools: "Workspace file tools", git_read: "Git read tools", application_launch: "Windows application launch",
  clipboard: "Clipboard", screenshots: "Screenshots", notifications: "Browser notifications",
  global_shortcut: "Global shortcut", system_tray: "System tray", window_controls: "Custom window controls",
  background_automation: "Background automation", scheduled_tasks: "Scheduled tasks", local_llm: "Local LLM",
  external_llm: "External LLM", stt_provider: "Speech recognition provider", tts_provider: "Speech output provider",
};

const TOOL_FOR_CHECK: Record<string, string> = {
  web_search: "web.search", weather: "web.weather", webpage_retrieval: "web.fetch",
  workspace_tools: "workspace.list", git_read: "development.git_status",
};

const REASONS: Record<string, string> = {
  voice_input: "MediaRecorder and microphone APIs are feature-detected; a real user-approved capture is still required.",
  push_to_talk: "Browser shortcut works only while this page is focused; it cannot register a system-wide key.",
  wake_word: "Browser wake listening requires the page to stay visible and an explicitly configured backend detector.",
  tts: "SpeechSynthesis support is detected; a local voice must complete a real playback test.",
  web_search: "A live search provider and backend-managed credential are required; mock results never count as success.",
  weather: "Open-Meteo is the supported no-key provider; a real location lookup is required.",
  webpage_retrieval: "Only backend-approved HTTPS origins can be fetched; approval is controlled by backend configuration.",
  workspace_tools: "Browser folder handles are not backend grants; filesystem operations remain bounded by backend-approved roots.",
  git_read: "Read-only Git access requires an approved repository and registered backend tools.",
  application_launch: "Web pages cannot launch local Windows applications.", clipboard: "No hidden clipboard integration is implemented.",
  screenshots: "No browser screenshot workflow is implemented.", notifications: "Notification API support does not imply permission or delivery.",
  global_shortcut: "Browser key handlers work only while this page is focused.", system_tray: "System tray integration is Electron-only.",
  window_controls: "Browser-native window controls replace custom desktop controls.", background_automation: "The browser page and local backend must remain running.",
  scheduled_tasks: "No operating-system scheduler is installed by browser mode.", local_llm: "The effective backend provider class is discovered without exposing its endpoint; a successful minimal inference is required for PASS.",
  external_llm: "The effective backend provider class is discovered without exposing credentials; a successful minimal inference is required for PASS.",
  stt_provider: "A real short recording is sent only after you start the configured backend transcription test.",
  tts_provider: "Browser-local speech is supported; remote backend TTS is not configurable here.",
};

function detectedBrowser(): string {
  const ua = navigator.userAgent;
  const match = ua.match(/(Edg|Chrome|Firefox|Version|Safari)\/([\d.]+)/);
  return match ? `${match[1]} ${match[2]}` : "Browser version not exposed";
}

function detectedOS(): string {
  const ua = navigator.userAgent;
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad/.test(ua)) return "iOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Not identified by browser user agent";
}

function supportedAudioMimeTypes(): string {
  if (typeof MediaRecorder === "undefined") return "not supported";
  return ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]
    .filter((mime) => MediaRecorder.isTypeSupported(mime))
    .join(", ") || "browser default only";
}

function currentOriginIsLoopback(): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname.toLowerCase());
}

function effectiveCheckStatus(check: ValidationCheck, evidence: BrowserSetupProgress["evidence"], runtime: { restartRequired?: boolean; llmKind?: "local" | "external" | "mock" | "unconfigured"; sttKind?: "local" | "external" | "mock" | "unconfigured"; ttsKind?: "local" | "external" | "mock" | "unconfigured"; searchKind?: "local" | "external" | "mock" | "unconfigured"; weatherKind?: "local" | "external" | "mock" | "unconfigured"; llmHealth?: "healthy" | "degraded" | "unavailable" | "unconfigured"; sttHealth?: "healthy" | "degraded" | "unavailable" | "unconfigured"; browserHealth: boolean }): ValidationStatus {
  if (runtime.restartRequired && check.requirement === "required") return "REQUIRES_RESTART";
  if (evidence[check.id]) return evidence[check.id].status;
  if (check.id === "web_search" || check.id === "weather") {
    const kind = check.id === "web_search" ? runtime.searchKind : runtime.weatherKind;
    if (kind === "unconfigured") return "UNCONFIGURED";
    if (kind === "mock") return "DEGRADED";
    if (kind === "local" || kind === "external") return "NOT_TESTED";
  }
  const providerStatus = check.id === "stt_provider"
    ? providerStatusForCheck(check.id, runtime.sttKind, runtime.sttHealth)
    : providerStatusForCheck(check.id, runtime.llmKind, runtime.llmHealth);
  if (providerStatus) return providerStatus;
  if (!runtime.browserHealth && check.id === "voice_input") return "FAILED";
  return evidence[check.id]?.status ?? check.status;
}

function evidenceCodeForCheck(id: string): EvidenceCode | null {
  if (id === "voice_input" || id === "push_to_talk") return "microphone_capture";
  if (id === "stt_provider") return "stt_transcription";
  if (id === "tts" || id === "tts_provider") return "local_tts";
  if (id === "web_search" || id === "weather" || id === "webpage_retrieval" || id === "workspace_tools" || id === "git_read") return "tool_health";
  if (id === "notifications") return "notification_delivery";
  if (id === "local_llm" || id === "external_llm" || id === "wake_word") return "provider_health";
  return null;
}

function sanitizedToolResult(toolId: string, result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return { status: "invalid_response" };
  const value = result as Record<string, unknown>;
  const output = value.data && typeof value.data === "object" && "output" in value.data
    ? (value.data as { output?: unknown }).output
    : null;
  const safe: Record<string, unknown> = {
    status: typeof value.status === "string" ? value.status : "unknown",
    summary: typeof value.summary === "string" ? value.summary.slice(0, 500) : "",
    duration_ms: typeof value.duration_ms === "number" ? value.duration_ms : null,
    error_code: typeof value.error_code === "string" ? value.error_code : null,
  };
  if (!output || typeof output !== "object") return safe;
  const data = output as Record<string, unknown>;
  if (toolId === "web.weather") {
    for (const key of ["location", "timezone", "observed_at", "temperature", "temperature_unit", "provider", "citation"]) {
      if (typeof data[key] === "string" || typeof data[key] === "number") safe[key] = data[key];
    }
  } else if (toolId === "web.search" && Array.isArray(data.results)) {
    safe.provider = data.provider;
    safe.sources = data.results.slice(0, 10).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const source = entry as Record<string, unknown>;
      return [{
        title: typeof source.title === "string" ? source.title.slice(0, 200) : "",
        url: typeof source.url === "string" ? source.url.slice(0, 2048) : "",
        citation: typeof source.citation === "string" ? source.citation.slice(0, 2048) : "",
      }];
    });
  } else if (toolId === "web.fetch") {
    for (const key of ["url", "title", "content_type", "citation", "fetched_at"]) {
      if (typeof data[key] === "string") safe[key] = (data[key] as string).slice(0, 2048);
    }
  } else if (toolId === "workspace.list" && Array.isArray(data.workspaces)) {
    safe.workspaces = data.workspaces.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const workspace = entry as Record<string, unknown>;
      if (typeof workspace.workspace_id !== "string" || typeof workspace.display_name !== "string") return [];
      return [{ workspace_id: workspace.workspace_id, display_name: workspace.display_name.slice(0, 120) }];
    });
  } else if (toolId === "workspace.files" && Array.isArray(data.entries)) {
    safe.entry_count = data.entries.length;
    safe.entry_types = [...new Set(data.entries.flatMap((entry) => entry && typeof entry === "object" && "entry_type" in entry && typeof entry.entry_type === "string" ? [entry.entry_type] : []))];
  } else if (toolId === "workspace.read") {
    safe.read = typeof data.contents === "string" ? "succeeded; contents discarded" : "no content returned";
    safe.relative_path = typeof data.relative_path === "string" ? data.relative_path.slice(0, 300) : "";
  } else if (toolId === "development.git_status") {
    safe.workspace_id = typeof data.workspace_id === "string" ? data.workspace_id : "";
    safe.branch_and_changes = typeof data.branch_and_changes === "string" ? data.branch_and_changes.slice(0, 2000) : "";
  }
  if (value.untrusted_content === true) safe.untrusted_content = true;
  return safe;
}

async function recordShortAudio(): Promise<Blob> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("This browser does not support microphone recording.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const mimeType = supportedRecorderMimeType();
  let recorder: MediaRecorder | undefined;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    const recording = new Promise<Blob>((resolve, reject) => {
      recorder?.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
      recorder?.addEventListener("error", () => reject(new Error("Browser audio capture failed.")), { once: true });
      recorder?.addEventListener("stop", () => resolve(new Blob(chunks, { type: recorder?.mimeType || mimeType || "" })), { once: true });
      recorder?.start();
    });
    await new Promise((resolve) => window.setTimeout(resolve, 1800));
    if (recorder.state !== "inactive") recorder.stop();
    const blob = await recording;
    const issue = validateBrowserRecording(blob);
    if (issue) throw new Error(issue);
    return blob;
  } finally {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    stream.getTracks().forEach((track) => track.stop());
  }
}

export function ManagedDeviceSetupWizard() {
  const navigate = useNavigate();
  const { preferences, updatePreferences } = usePreferences();
  const backend = useBackendHealth();
  const llm = useQuery({ queryKey: ["backend", "llm-health"], queryFn: ({ signal }) => api.llmHealth(signal), enabled: false });
  const runtimeStatus = useQuery({ queryKey: ["runtime-provider-status"], queryFn: ({ signal }) => api.runtimeProviderStatus(signal) });
  const voice = useQuery({ queryKey: ["voice", "health"], queryFn: ({ signal }) => api.voiceHealth(signal) });
  const tools = useQuery({ queryKey: ["tools", "list"], queryFn: ({ signal }) => api.listTools(signal) });
  const grants = useQuery({ queryKey: ["permissions", "grants"], queryFn: ({ signal }) => api.listGrants(signal) });
  const audit = useQuery({ queryKey: ["audit", "wizard"], queryFn: ({ signal }) => api.audit(10, 0, signal) });
  const eventConnection = useAppStore((state) => state.eventConnection);
  const setPendingConfirmation = useAppStore((state) => state.setPendingConfirmation);
  const [progress, setProgress] = useState<BrowserSetupProgress>(() => loadSetupProgress());
  const [installStatus, setInstallStatus] = useState(pwaInstallAvailability);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [microphonePermission, setMicrophonePermission] = useState<PermissionState | "unknown" | "unsupported">("unknown");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState("");
  const [directoryName, setDirectoryName] = useState("");
  const [directoryReadSummary, setDirectoryReadSummary] = useState("");
  const [approvedWorkspaces, setApprovedWorkspaces] = useState<Array<{ workspace_id: string; display_name: string }>>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [relativePath, setRelativePath] = useState("");
  const [fetchUrl, setFetchUrl] = useState("");
  const [audioInputCount, setAudioInputCount] = useState<number | null>(null);
  const [weatherLocation, setWeatherLocation] = useState("");
  const [searchQuery, setSearchQuery] = useState("latest public AI research news");
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [toolResult, setToolResult] = useState<unknown>(null);
  const capabilities = browserCapabilityMatrix();
  const currentStep = WIZARD_STEPS[progress.stepIndex] ?? WIZARD_STEPS[0];
  const browserFeaturesDetected = browserFeatures();
  const checks = useMemo(() => buildInitialValidationChecks(capabilities).map((check) => ({
    ...check,
    status: effectiveCheckStatus(check, progress.evidence, {
      restartRequired: runtimeStatus.data?.restartRequired,
      llmKind: runtimeStatus.data?.providers.llm,
      sttKind: runtimeStatus.data?.providers.stt,
      ttsKind: runtimeStatus.data?.providers.tts,
      searchKind: runtimeStatus.data?.providers.search,
      weatherKind: runtimeStatus.data?.providers.weather,
      llmHealth: llm.data?.status,
      sttHealth: voice.data?.stt.status,
      browserHealth: Boolean(backend.data),
    }),
    detail: REASONS[check.id] ?? check.detail,
  })), [capabilities, progress.evidence, runtimeStatus.data?.providers, llm.data?.status, voice.data?.stt.status, backend.data]);
  const passedChecks = checks.filter((check) => check.status === "PASS").length;
  const readiness = readinessStatus(checks, backend.data?.status, eventConnection, runtimeStatus.data?.providers.llm);

  useEffect(() => saveSetupProgress(progress), [progress]);
  useEffect(() => {
    setNotificationPermission("Notification" in window ? Notification.permission : "unsupported");
    void navigator.permissions?.query({ name: "microphone" as PermissionName }).then((status) => {
      setMicrophonePermission(status.state);
      status.addEventListener("change", () => setMicrophonePermission(status.state));
    }).catch(() => setMicrophonePermission("unsupported"));
    if (typeof window.speechSynthesis !== "undefined") {
      const refresh = () => setVoices(window.speechSynthesis.getVoices().filter((voice) => voice.localService));
      refresh();
      window.speechSynthesis.addEventListener("voiceschanged", refresh);
      return () => window.speechSynthesis.removeEventListener("voiceschanged", refresh);
    }
    return undefined;
  }, []);
  useEffect(() => {
    const refresh = () => setInstallStatus(pwaInstallAvailability());
    window.addEventListener("jarvis-pwa-install-available", refresh);
    window.addEventListener("jarvis-pwa-install-unavailable", refresh);
    window.addEventListener("jarvis-pwa-installed", refresh);
    return () => {
      window.removeEventListener("jarvis-pwa-install-available", refresh);
      window.removeEventListener("jarvis-pwa-install-unavailable", refresh);
      window.removeEventListener("jarvis-pwa-installed", refresh);
    };
  }, []);

  function updateProgress(patch: Partial<BrowserSetupProgress>) {
    setProgress((current) => ({ ...current, ...patch }));
  }

  function setStep(index: number) {
    updateProgress({ stepIndex: Math.max(0, Math.min(WIZARD_STEPS.length - 1, index)) });
    setMessage("");
    setError("");
  }

  function setEvidence(ids: string[], status: ValidationStatus, code: EvidenceCode) {
    const testedAt = new Date().toISOString();
    setProgress((current) => ({
      ...current,
      evidence: {
        ...current.evidence,
        ...Object.fromEntries(ids.map((id) => [id, { status, testedAt, code }])),
      },
    }));
  }

  function clearEvidence(id?: string) {
    setProgress((current) => {
      const evidence = { ...current.evidence };
      if (id) delete evidence[id];
      else for (const check of checks) delete evidence[check.id];
      return { ...current, evidence };
    });
    setMessage("Test evidence reset. No configuration or backend grant was changed.");
    setError("");
  }

  function skipCurrentStep() {
    const skippedSteps = [...new Set([...progress.skippedSteps, currentStep.id])];
    updateProgress({ skippedSteps, stepIndex: Math.min(progress.stepIndex + 1, WIZARD_STEPS.length - 1) });
    setMessage(`${currentStep.title} skipped for now. Progress is saved without secrets.`);
    setError("");
  }

  async function runHealthTest() {
    setBusy(true); setError(""); setMessage("Checking the loopback backend and authenticated event stream…");
    try {
      const result = await backend.refetch();
      if (!result.data || result.data.status !== "healthy") throw new Error("Backend health did not report healthy.");
      setEvidence(["backend_connection"], "PASS", "backend_health");
      setMessage(`Backend health passed at ${new Date(result.data.checkedAt).toLocaleTimeString()}. Event stream: ${eventConnection}.`);
      if (eventConnection === "connected") setEvidence(["websocket_connection"], "PASS", "backend_health");
      else setMessage("Backend health passed; authenticated WebSocket is not connected yet. Keep this page open and retry.");
    } catch (cause) {
      setEvidence(["backend_connection"], "FAILED", "backend_health");
      setError(cause instanceof Error ? cause.message : "Backend health test failed.");
    } finally { setBusy(false); }
  }

  async function testMicrophone() {
    setBusy(true); setError(""); setMessage("Requesting microphone access for this test only…");
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState !== "live") throw new Error("The browser did not provide a live audio track.");
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioInputCount(devices.filter((device) => device.kind === "audioinput").length);
      setEvidence(["voice_input", "push_to_talk"], "PASS", "microphone_capture");
      setMessage(`Microphone capture passed (${track.getSettings().sampleRate ?? "browser default"} Hz, ${devices.filter((device) => device.kind === "audioinput").length} input device(s) reported). The stream will be stopped now.`);
      setMicrophonePermission("granted");
    } catch (cause) {
      const denied = cause instanceof DOMException && cause.name === "NotAllowedError";
      setEvidence(["voice_input"], denied ? "REQUIRES_USER_ACTION" : "FAILED", "microphone_capture");
      setMicrophonePermission(denied ? "denied" : microphonePermission);
      setError(cause instanceof Error ? cause.message : "Microphone test failed.");
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      setBusy(false);
    }
  }

  async function testStt() {
    setBusy(true); setError(""); setTranscript(""); setMessage("Recording for 1.8 seconds. Say a short phrase now; audio is sent only to the configured backend STT provider.");
    try {
      const audio = await recordShortAudio();
      const result = await api.transcribeVoice(audio, crypto.randomUUID(), true, 0);
      if (!result.text.trim()) throw new Error("The provider returned an empty transcript; no PASS was recorded.");
      setTranscript(result.text);
      setEvidence(["stt_provider"], "PASS", "stt_transcription");
      setMessage(`Real transcription succeeded through ${result.provider} in ${result.language}. Temporary audio has been released.`);
    } catch (cause) {
      const status = voice.data?.stt.status === "unconfigured" ? "REQUIRES_CREDENTIALS" : "FAILED";
      setEvidence(["stt_provider"], status, "stt_transcription");
      setError(cause instanceof Error ? cause.message : "Speech-to-text test failed.");
    } finally { setBusy(false); }
  }

  function applySpeechPreferences(patch: Partial<BrowserSetupProgress["preferences"]>) {
    const preferences = { ...progress.preferences, ...patch };
    updateProgress({ preferences });
    void updatePreferences({
      voiceOutputEnabled: true,
      voiceOutputVoiceURI: preferences.voiceURI,
      voiceOutputRate: preferences.speechRate,
      voiceOutputVolume: preferences.speechVolume,
      language: preferences.language,
      timezone: preferences.timezone,
    });
  }

  function testTts() {
    if (!window.speechSynthesis || voices.length === 0) {
      setEvidence(["tts", "tts_provider"], "UNSUPPORTED", "local_tts");
      setError("No browser-local SpeechSynthesis voice is available.");
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance("JARVIS browser-local speech test.");
    utterance.voice = voices.find((voice) => voice.voiceURI === progress.preferences.voiceURI) ?? voices[0];
    utterance.lang = progress.preferences.language;
    utterance.rate = progress.preferences.speechRate;
    utterance.volume = progress.preferences.speechVolume;
    setError(""); setMessage("Playing a neutral local test sentence…"); setTtsPlaying(true);
    utterance.onend = () => {
      setTtsPlaying(false);
      setEvidence(["tts", "tts_provider"], "PASS", "local_tts");
      setMessage(`Playback completed using ${utterance.voice?.name ?? "the selected local voice"}.`);
    };
    utterance.onerror = () => {
      setTtsPlaying(false);
      setEvidence(["tts", "tts_provider"], "FAILED", "local_tts");
      setError("Browser speech playback reported an error.");
    };
    window.speechSynthesis.speak(utterance);
  }

  function stopTts() {
    window.speechSynthesis?.cancel();
    setTtsPlaying(false);
    setMessage("Speech playback stopped by the user.");
  }

  async function testLlm() {
    const providerKind = runtimeStatus.data?.providers.llm;
    if (providerKind !== "local" && providerKind !== "external") {
      setMessage(providerKind === "mock"
        ? "A mock LLM is active. It is not a real provider and will not be tested as successful."
        : "No effective LLM provider is configured. Configure one and restart the owned JARVIS profile first.");
      return;
    }
    setBusy(true); setError("");
    try {
      const result = await llm.refetch();
      if (result.data?.status === "healthy") {
        const startedAt = performance.now();
        const inference = await api.submitCommand("For this setup test, reply with exactly: JARVIS connection test. Do not call tools or request permission.");
        const elapsedMs = Math.round(performance.now() - startedAt);
        if (inference.confirmationRequest) {
          const confirmation = assistantConfirmation(inference);
          if (confirmation) setPendingConfirmation(confirmation);
          setEvidence([providerKind === "local" ? "local_llm" : "external_llm"], "REQUIRES_USER_ACTION", "provider_health");
          setMessage("The model unexpectedly requested permission. No action was approved; review or deny the request in the confirmation dialog. This inference test does not count as passed.");
          return;
        }
        const directResponse = inference.intent?.kind === "direct_response"
          && (inference.plan?.steps.length ?? 0) === 0
          && inference.toolResults.length === 0;
        if (directResponse && inference.assistantMessage?.content && inference.status === "completed") {
          setEvidence([providerKind === "local" ? "local_llm" : "external_llm"], "PASS", "provider_health");
          setMessage(`Real ${providerKind} minimal inference completed in ${elapsedMs} ms. The active provider check passed; structured output and tool-calling compatibility were not tested.`);
        } else {
          setEvidence([providerKind === "local" ? "local_llm" : "external_llm"], "FAILED", "provider_health");
          setMessage("The configured provider did not complete a direct response without tools. No tool was automatically approved; review the command and audit flow.");
        }
      } else {
        const failedStatus = result.data?.status === "unconfigured" ? "REQUIRES_CREDENTIALS" : result.data?.status === "degraded" ? "DEGRADED" : "FAILED";
        setEvidence([providerKind === "local" ? "local_llm" : "external_llm"], failedStatus, "provider_health");
        setMessage(result.data?.message ?? "Provider health is unavailable. Local versus external configuration is not exposed.");
        setError("The configured provider did not pass its health and minimal-inference test.");
      }
    } catch (cause) {
      setEvidence([providerKind === "local" ? "local_llm" : "external_llm"], "FAILED", "provider_health");
      setError(cause instanceof Error ? cause.message : "Provider test failed.");
    }
    finally { setBusy(false); }
  }

  async function selectDirectory() {
    const pickerWindow = window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> };
    if (!directoryPickerSupported(pickerWindow.showDirectoryPicker)) {
      setError("This browser does not expose the directory picker. Backend workspace approval remains separate.");
      return;
    }
    try {
      const handle = await pickerWindow.showDirectoryPicker?.();
      if (!handle) return;
      setDirectoryName(handle.name);
      let count = 0;
      const iterableHandle = handle as FileSystemDirectoryHandle & { values?: () => AsyncIterableIterator<FileSystemHandle> };
      if (!iterableHandle.values) throw new Error("This browser can select folders but cannot enumerate their entries.");
      for await (const _entry of iterableHandle.values()) { count += 1; if (count >= 500) break; }
      setDirectoryReadSummary(`Read ${count}${count >= 500 ? "+" : ""} top-level entries from the folder you selected. This temporary browser handle is not a backend workspace grant.`);
      setEvidence(["workspace_tools"], "DEGRADED", "tool_health");
      setError("");
    } catch (cause) {
      const outcome = directoryPickerOutcome(cause);
      setError(outcome === "cancelled" ? "Folder selection was cancelled." : outcome === "not_allowed" ? "The browser denied directory access." : "Directory access was blocked or unavailable; organization policy cannot be inferred.");
    }
  }

  async function testSelectedTextFile() {
    const pickerWindow = window as Window & { showOpenFilePicker?: (options?: unknown) => Promise<Array<{ getFile: () => Promise<File> }>> };
    if (!pickerWindow.showOpenFilePicker) { setError("This browser does not expose the file picker."); return; }
    try {
      const [handle] = await pickerWindow.showOpenFilePicker({ multiple: false, types: [{ description: "Text files", accept: { "text/plain": [".txt", ".md"] } }] });
      if (!handle) return;
      const file = await handle.getFile();
      if (file.size > 256 * 1024) throw new Error("Choose a text file no larger than 256 KiB.");
      const text = await file.text();
      setDirectoryReadSummary(`Read succeeded for your selected file (${file.size} bytes). Contents were not displayed, uploaded, or retained. This does not test backend workspace containment.`);
      setMessage(`Selected ${file.name}; ${text.length} text characters were read in memory and discarded.`);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The selected text file could not be read."); }
  }

  async function requestNotifications() {
    if (!("Notification" in window)) { setNotificationPermission("unsupported"); setError("Notifications are not supported by this browser."); return; }
    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission === "denied") {
        setEvidence(["notifications"], "REQUIRES_USER_ACTION", "notification_delivery");
        setError("Permission is denied. The browser does not distinguish user denial from organization policy. Use in-app notifications; JARVIS will not retry or change policy.");
      } else if (permission === "granted") setMessage("Permission granted by the browser. Run Test to verify delivery.");
      else setMessage("Permission was not granted. You can continue with in-app notifications.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The browser could not request notification permission."); }
  }

  function testNotification() {
    if (notificationPermission !== "granted") { setError("Grant notification permission first using the explicit Configure action."); return; }
    const notification = new Notification("JARVIS setup test", { body: "Browser notification delivery test." });
    notification.onshow = () => { setEvidence(["notifications"], "PASS", "notification_delivery"); setMessage("The browser displayed the test notification."); };
    notification.onerror = () => { setEvidence(["notifications"], "FAILED", "notification_delivery"); setError("The browser did not display the test notification."); };
    window.setTimeout(() => notification.close(), 5000);
  }

  async function runToolHealth(toolId: string, checkIds: string[]) {
    setBusy(true); setError(""); setToolResult(null);
    try {
      const result = await api.toolHealth(toolId);
      const status = result.status === "healthy" ? "DEGRADED" : result.status === "unconfigured" ? "UNCONFIGURED" : result.status === "degraded" ? "DEGRADED" : "FAILED";
      setEvidence(checkIds, status, "tool_health");
      setMessage(`${toolId}: ${result.status}. ${result.message} Health does not replace a real execution test.`);
    } catch (cause) { setEvidence(checkIds, "FAILED", "tool_health"); setError(cause instanceof Error ? cause.message : `${toolId} health test failed.`); }
    finally { setBusy(false); }
  }

  async function executeRealTool(toolId: string, arguments_: Record<string, unknown>, checkId: string) {
    setBusy(true); setError(""); setToolResult(null);
    try {
      const execution = await api.executeTool(toolId, arguments_);
      setToolResult(sanitizedToolResult(toolId, execution.result));
      if (execution.result.status === "succeeded") {
        const output = execution.result.data?.output ?? {};
        if (toolId === "workspace.list" && Array.isArray(output.workspaces)) {
          const workspaces = output.workspaces.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const workspace = entry as Record<string, unknown>;
            if (typeof workspace.workspace_id !== "string" || typeof workspace.display_name !== "string") return [];
            return [{ workspace_id: workspace.workspace_id, display_name: workspace.display_name }];
          });
          setApprovedWorkspaces(workspaces);
          setSelectedWorkspaceId(workspaces[0]?.workspace_id ?? "");
          setEvidence([checkId], workspaces.length ? "PASS" : "UNCONFIGURED", "tool_health");
          setMessage(workspaces.length ? `Listed ${workspaces.length} backend-approved workspace(s). Select one to run bounded read tests.` : "The backend returned no approved workspace. Nothing was scanned or inferred.");
          return;
        }
        if (toolId === "workspace.files" && Array.isArray(output.entries)) {
          setEvidence([checkId], "PASS", "tool_health");
          setMessage(`The backend listed ${output.entries.length} entries within the selected approved workspace.`);
          return;
        }
        if (toolId === "workspace.read") {
          const contents = typeof output.contents === "string" ? output.contents : "";
          setEvidence([checkId], contents ? "PASS" : "FAILED", "tool_health");
          setMessage(contents ? `Read succeeded for the explicitly selected ${relativePath} file (${contents.length} characters); its contents were discarded and not displayed or retained.` : "The approved workspace read returned no text content.");
          return;
        }
        const provider = typeof output.provider === "string" ? output.provider : "unknown";
        const status = provider === "mock" ? "DEGRADED" : "PASS";
        setEvidence([checkId], status, "tool_health");
        setMessage(provider === "mock" ? "A development mock responded. This is not a real provider test and cannot count as PASS." : `Live ${provider} tool execution succeeded in ${execution.result.duration_ms} ms.`);
      } else if (execution.result.status === "confirmation_required" && execution.confirmationId) {
        const ticket = await api.getConfirmation(execution.confirmationId);
        setPendingConfirmation({ mode: "tool", toolId, arguments: arguments_, confirmationId: execution.confirmationId, ticket: { riskLevel: ticket.risk_level, scopes: ticket.scopes, arguments: ticket.masked_arguments, resources: ticket.affected_resources } });
        setMessage("The backend requested permission. Review the existing approval dialog; this wizard does not approve it.");
      } else {
        const status = execution.result.status === "unconfigured" ? "REQUIRES_CREDENTIALS" : execution.result.status === "denied" ? "BLOCKED_BY_POLICY" : "FAILED";
        setEvidence([checkId], status, "tool_health");
        setError(`${execution.result.status}: ${execution.result.summary}${execution.result.error_code ? ` (${execution.result.error_code})` : ""}`);
      }
    } catch (cause) { setEvidence([checkId], "FAILED", "tool_health"); setError(cause instanceof Error ? cause.message : "Tool execution failed."); }
    finally { setBusy(false); }
  }

  async function testGrantsAndAudit() {
    setBusy(true); setError("");
    try {
      const [grantRows, auditRows] = await Promise.all([api.listGrants(), api.audit(10, 0)]);
      setEvidence(["permissions_audit"], "DEGRADED", "grant_audit_read");
      setMessage(`Read ${grantRows.length} active grants and ${auditRows.length} recent audit records. No grant was created, approved, or changed; decision testing remains manual in the existing confirmation flow.`);
    } catch (cause) { setEvidence(["permissions_audit"], "FAILED", "grant_audit_read"); setError(cause instanceof Error ? cause.message : "Permission/audit read test failed."); }
    finally { setBusy(false); }
  }

  function listApprovedWorkspaces() {
    void executeRealTool("workspace.list", {}, "workspace_tools");
  }

  function listWorkspaceFiles() {
    if (!selectedWorkspaceId) { setError("First list and select a backend-approved workspace."); return; }
    void executeRealTool("workspace.files", { workspace_id: selectedWorkspaceId, relative_path: ".", max_depth: 0 }, "workspace_tools");
  }

  function readApprovedTextFile() {
    const normalizedPath = relativePath.trim().replaceAll("\\", "/");
    if (!selectedWorkspaceId) { setError("First list and select a backend-approved workspace."); return; }
    if (!normalizedPath || normalizedPath.startsWith("/") || normalizedPath.includes(":") || normalizedPath.split("/").some((part) => part === "..") || !/\.(txt|md)$/i.test(normalizedPath)) {
      setError("Enter a relative .txt or .md path inside the selected approved workspace; parent traversal and absolute paths are rejected.");
      return;
    }
    void executeRealTool("workspace.read", { workspace_id: selectedWorkspaceId, relative_path: normalizedPath }, "workspace_tools");
  }

  function testGitStatus() {
    if (!selectedWorkspaceId) { setError("First list and select a backend-approved workspace."); setStep(WIZARD_STEPS.findIndex((step) => step.id === "workspace")); return; }
    void executeRealTool("development.git_status", { workspace_id: selectedWorkspaceId }, "git_read");
  }

  function fetchApprovedPage() {
    let url: URL;
    try { url = new URL(fetchUrl.trim()); } catch { setError("Enter an absolute HTTPS URL on a backend-approved origin."); return; }
    if (url.protocol !== "https:" || url.username || url.password) { setError("Only credential-free HTTPS URLs are accepted. The backend still enforces its exact origin allowlist."); return; }
    void executeRealTool("web.fetch", { url: url.toString() }, "webpage_retrieval");
  }

  async function installPwa() {
    setBusy(true); setError("");
    try {
      const installed = await requestPwaInstall();
      setMessage(installed ? "The browser accepted the PWA installation request." : "The browser dismissed the installation prompt. The normal browser tab remains supported.");
      setInstallStatus(pwaInstallAvailability());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "PWA installation was not available."); }
    finally { setBusy(false); }
  }

  function configureCheck(id: string) {
    const step = stepForCheck(id);
    const index = WIZARD_STEPS.findIndex((candidate) => candidate.id === step);
    setStep(index < 0 ? WIZARD_STEPS.length - 1 : index);
    document.querySelector(".setup-wizard")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function testCheck(id: string) {
    setError(""); setMessage("");
    if (id === "voice_input" || id === "push_to_talk") { void testMicrophone(); return; }
    if (id === "stt_provider") { void testStt(); return; }
    if (id === "tts" || id === "tts_provider") { testTts(); return; }
    if (id === "notifications") { testNotification(); return; }
    if (id === "web_search") { void executeRealTool("web.search", { query: searchQuery.trim() }, id); return; }
    if (id === "weather") {
      if (!weatherLocation.trim()) { setError("Enter a location for a real weather lookup."); configureCheck(id); return; }
      void executeRealTool("web.weather", { location: weatherLocation.trim() }, id); return;
    }
    if (id === "webpage_retrieval") { fetchApprovedPage(); return; }
    if (id === "workspace_tools") { listApprovedWorkspaces(); return; }
    if (id === "git_read") { testGitStatus(); return; }
    if (id === "local_llm" || id === "external_llm") { void testLlm(); return; }
    if (id === "wake_word") {
      void voice.refetch().then((result) => {
        const status = result.data?.wakeWord.status === "healthy" ? "DEGRADED" : result.data?.wakeWord.status === "unconfigured" ? "UNCONFIGURED" : "FAILED";
        setEvidence([id], status, "provider_health");
        setMessage("Backend wake-provider health was checked. Background listening is unsupported after this page closes.");
      }); return;
    }
    const toolId = TOOL_FOR_CHECK[id];
    if (toolId) {
      void runToolHealth(toolId, [id]);
      return;
    }
    if (["application_launch", "clipboard", "screenshots", "global_shortcut", "system_tray", "window_controls", "background_automation", "scheduled_tasks"].includes(id)) {
      setEvidence([id], "UNSUPPORTED", "provider_health");
      setMessage("Confirmed by the browser deployment boundary. See the Configure panel for the closest safe alternative.");
      return;
    }
    setMessage("This check requires a user action described in its setup step. No PASS was recorded.");
  }

  function download(format: "json" | "text") {
    const blob = new Blob([validationExport(checks, format)], { type: format === "json" ? "application/json" : "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `jarvis-managed-validation.${format === "json" ? "json" : "txt"}`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function stepConfigure() {
    switch (currentStep.id) {
      case "data":
      case "retention":
        setEvidence(["data_directory"], "REQUIRES_RESTART", "backend_health");
        setMessage("The backend does not expose a runtime data-directory/retention editor. Set JARVIS_DATA_DIR and approved retention settings in the user-level launch environment, then restart only JARVIS-owned processes.");
        break;
      case "wake":
        saveBrowserShortcutPreferences({ enabled: true, shortcut: "Ctrl+Space" });
        void updatePreferences({ voiceShortcutEnabled: true, wakeWordEnabled: false });
        setMessage("Configured page-focused Ctrl+Space push-to-talk and left background wake disabled. This does not register a global shortcut.");
        break;
      case "live-tests":
      setMessage("Open Tools & Skills to inspect provider state. Weather uses Open-Meteo without a key when enabled; search credentials remain backend-managed.");
        break;
      case "workspace":
        setMessage("You may select one folder below for a temporary browser-only read test. To grant backend access, an operator must add an approved workspace root and scope.");
        break;
      case "applications":
        setEvidence(["application_launch"], "UNSUPPORTED", "provider_health");
        setMessage("No browser configuration can grant Windows process-launch rights. Use an approved website or open the project folder manually.");
        break;
      case "notifications":
        void requestNotifications();
        break;
      case "permissions":
        setMessage("No permission defaults or grants are changed here. Review backend grants and test tool scopes in Tools & Skills; approve only a real request you understand.");
        break;
      case "voice-command":
        setMessage("Open Command Center and use the actual push-to-talk control. Say: ‘Jarvis, tell me the current time.’ The command, tool, permission, audit, and speech path must complete in the running app.");
        break;
      default:
        setMessage("Use only the controls shown for this step. No secrets are collected in this wizard.");
    }
  }

  function testStep() {
    switch (currentStep.id) {
      case "connection": void runHealthTest(); break;
      case "microphone": void testMicrophone(); break;
      case "stt": void testStt(); break;
      case "tts": testTts(); break;
      case "llm": void testLlm(); break;
      case "live-tests":
        setMessage("Choose an enabled provider below and run its live query. A tool-health response alone is not counted as PASS.");
        break;
      case "workspace": void selectDirectory(); break;
      case "notifications": testNotification(); break;
      case "permissions": void testGrantsAndAudit(); break;
      case "voice-command": setMessage("This end-to-end test requires you to speak and review the live command and permission flow. Open Command Center to begin."); break;
      case "data":
      case "retention": setEvidence(["data_directory"], "REQUIRES_RESTART", "backend_health"); setMessage("The process does not expose its data directory or retention state to the renderer. No filesystem scan was performed."); break;
      case "wake": setMessage("Push-to-talk is page-focused only. Press the configured shortcut while this page is focused to test it; browser mode cannot validate a global key or background wake."); break;
      case "git":
      case "applications":
      case "readiness": setMessage("See the capability checklist for the real per-tool test, current evidence, and exact next action."); break;
    }
  }

  const registeredTools = tools.data ?? [];
  const weatherTool = registeredTools.find((tool) => tool.manifest.tool_id === "web.weather" && tool.enabled);
  const searchTool = registeredTools.find((tool) => tool.manifest.tool_id === "web.search" && tool.enabled);
  const voiceLabel = voices.find((voice) => voice.voiceURI === progress.preferences.voiceURI)?.name ?? "Automatic local voice";
  const resetPreference = () => {
    updateProgress({ preferences: { ...EMPTY_SETUP_PROGRESS.preferences, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" } });
    clearEvidence();
  };

  return <div className="page-content managed-setup-page">
    <PageHeading eyebrow="DEPLOYMENT / SETUP" title="Managed Device Setup" description="A resumable, evidence-based setup for this browser profile. Secrets are never requested or stored here." action={<div className="heading-actions"><Button variant="outline" onClick={() => { void backend.refetch(); void runtimeStatus.refetch(); void voice.refetch(); void tools.refetch(); void grants.refetch(); void audit.refetch(); }}><RotateCcw size={14} /> Refresh discovery</Button><Button variant="outline" onClick={() => download("json")}><ArrowDownToLine size={14} /> Export</Button></div>} />

    <Panel className="setup-summary">
      <div className="setup-readiness"><div><p className="eyebrow">OVERALL READINESS</p><strong>{readiness}</strong><span>{passedChecks} of 22 checks have real PASS evidence. Unsupported and unconfigured capabilities are not counted as ready.</span></div><Badge tone={readiness === "READY_FOR_BROWSER_PERSONAL_USE" ? "green" : readiness === "BLOCKED_BY_POLICY" ? "danger" : "amber"}>{readiness.replaceAll("_", " ")}</Badge></div>
      <div className="setup-facts"><Fact label="Mode" value={deploymentMode()} /><Fact label="Browser" value={detectedBrowser()} /><Fact label="Operating system" value={detectedOS()} /><Fact label="Origin" value={`${window.location.origin} · ${currentOriginIsLoopback() ? "loopback" : "not loopback"}`} /><Fact label="Backend" value={backend.data?.status ?? (backend.isError ? "FAILED" : "checking")} /><Fact label="LLM class" value={runtimeStatus.data?.providers.llm ?? (runtimeStatus.isError ? "unavailable" : "checking")} /><Fact label="STT class" value={runtimeStatus.data?.providers.stt ?? (runtimeStatus.isError ? "unavailable" : "checking")} /><Fact label="Authenticated event stream" value={eventConnection} /><Fact label="Timezone" value={Intl.DateTimeFormat().resolvedOptions().timeZone || "not exposed"} /><Fact label="PWA" value={installStatus === "unavailable_or_not_offered" ? PWA_INSTALL_UNDETERMINED_MESSAGE : installStatus} /></div>
      <details className="setup-discovery"><summary>Automatic discovery · user-space only</summary><div className="setup-facts"><Fact label="Standalone PWA" value={browserFeaturesDetected.standalone ? "installed standalone" : "browser tab"} /><Fact label="Secure context" value={browserFeaturesDetected.secureContext ? "secure" : "not secure"} /><Fact label="Microphone API" value={browserFeaturesDetected.microphone ? "supported" : "unsupported"} /><Fact label="MediaRecorder" value={browserFeaturesDetected.mediaRecorder ? supportedAudioMimeTypes() : "unsupported"} /><Fact label="SpeechRecognition" value={browserFeaturesDetected.speechRecognition ? "browser API present; not used" : "not exposed"} /><Fact label="Local speech voices" value={String(voices.length)} /><Fact label="Notification permission" value={notificationPermission} /><Fact label="Directory picker" value={typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === "function" ? "supported; user selection required" : "not exposed"} /><Fact label="Clipboard API" value={typeof navigator.clipboard?.readText === "function" ? "supported; no clipboard read performed" : "not exposed"} /><Fact label="Service worker" value={browserFeaturesDetected.serviceWorker ? "supported" : "unsupported"} /><Fact label="Backend port" value="Private to owned supervisor; no port scan performed" /><Fact label="Machine inventory" value="Not scanned" /></div><p>Effective provider classes and enabled tools are discovered without exposing endpoints, credentials, secret references, model paths, or workspace paths. Provider health, inference, and external service requests run only after you activate their tests.</p></details>
      <p className="setup-security-note"><ShieldCheck size={15} /> Loopback/session/origin controls and backend permissions remain authoritative. No admin access, global policy changes, model downloads, machine scans, or mock success.</p>
    </Panel>

    <div className="setup-layout">
      <nav className="setup-step-nav" aria-label="Setup steps">
        <div className="setup-step-nav-heading"><span>SETUP ORDER</span><Badge tone="cyan">{progress.stepIndex + 1} / {WIZARD_STEPS.length}</Badge></div>
        {WIZARD_STEPS.map((step, index) => <button className={`setup-step-link ${index === progress.stepIndex ? "active" : ""} ${progress.skippedSteps.includes(step.id) ? "skipped" : ""}`} key={step.id} onClick={() => setStep(index)} aria-current={index === progress.stepIndex ? "step" : undefined}><span className="setup-step-number">{index + 1}</span><span>{step.title}</span>{progress.skippedSteps.includes(step.id) && <small>Skipped</small>}</button>)}
        <Button variant="outline" onClick={() => navigate("/settings")}>Resume later <ArrowRight size={14} /></Button>
      </nav>

      <Panel className="setup-wizard" aria-labelledby="setup-step-title">
        <div className="setup-step-header"><div><p className="eyebrow">STEP {String(progress.stepIndex + 1).padStart(2, "0")} / {WIZARD_STEPS.length}</p><h2 id="setup-step-title">{currentStep.title}</h2><p>{currentStep.summary}</p></div><Badge tone="neutral">{currentStep.checks.length ? `${currentStep.checks.length} related checks` : "Readiness"}</Badge></div>
        <StepContent
          stepId={currentStep.id}
          backendStatus={backend.data?.status ?? (backend.isError ? "failed" : "checking")}
          backendMessage={backend.data ? `${backend.data.checks?.filter((check) => check.status === "healthy").length ?? 0} backend health checks healthy.` : backend.error?.message ?? "Waiting for a real backend health response."}
          eventConnection={eventConnection}
          microphonePermission={microphonePermission}
          notificationPermission={notificationPermission}
          features={browserFeaturesDetected}
          llmStatus={llm.data?.status ?? "not tested"}
          llmMessage={llm.data?.message ?? "Provider health and inference run only after you activate the explicit test."}
          sttStatus={voice.data?.stt.status ?? "checking"}
          sttMessage={voice.data?.stt.message ?? "Provider health has not been read yet."}
          wakeMessage={voice.data?.wakeWord.message ?? "Provider health has not been read yet."}
          tools={registeredTools}
          grantsCount={grants.data?.length}
          auditCount={audit.data?.length}
          preferences={progress.preferences}
          voices={voices}
          voiceLabel={voiceLabel}
          weatherTool={weatherTool}
          searchTool={searchTool}
          weatherLocation={weatherLocation}
          searchQuery={searchQuery}
          directoryName={directoryName}
          directoryReadSummary={directoryReadSummary}
          transcript={transcript}
          toolResult={toolResult}
          message={message}
          error={error}
          busy={busy}
          ttsPlaying={ttsPlaying}
          installStatus={installStatus}
          approvedWorkspaces={approvedWorkspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          relativePath={relativePath}
          fetchUrl={fetchUrl}
          audioInputCount={audioInputCount}
          onTestHealth={() => void runHealthTest()}
          onTestMicrophone={() => void testMicrophone()}
          onTestStt={() => void testStt()}
          onTestTts={testTts}
          onStopTts={stopTts}
          onTestLlm={() => void testLlm()}
          onTestToolHealth={(toolId, ids) => void runToolHealth(toolId, ids)}
          onExecuteTool={(toolId, args, id) => void executeRealTool(toolId, args, id)}
          onTestDirectory={() => void selectDirectory()}
          onTestTextFile={() => void testSelectedTextFile()}
          onRequestNotifications={() => void requestNotifications()}
          onTestNotification={testNotification}
          onTestGrants={() => void testGrantsAndAudit()}
          onListWorkspaces={listApprovedWorkspaces}
          onListWorkspaceFiles={listWorkspaceFiles}
          onReadWorkspaceTextFile={readApprovedTextFile}
          onGitStatus={testGitStatus}
          onFetchPage={fetchApprovedPage}
          onInstallPwa={() => void installPwa()}
          onWorkspaceSelect={setSelectedWorkspaceId}
          onRelativePath={setRelativePath}
          onFetchUrl={setFetchUrl}
          onConfigure={stepConfigure}
          onSpeechPreference={applySpeechPreferences}
          onWeatherLocation={setWeatherLocation}
          onSearchQuery={setSearchQuery}
          onSetMessage={setMessage}
        />
        <RuntimeConfigurationEditor
          stepId={currentStep.id}
          onSpeechPreference={applySpeechPreferences}
          onConfigurationChanged={() => { clearEvidence(); void runtimeStatus.refetch(); }}
        />
        {(message || error) && <div className={`setup-feedback ${error ? "error" : ""}`} role={error ? "alert" : "status"}>{error || message}</div>}
        {transcript && <div className="setup-transcript"><strong>Live transcript</strong><p>{transcript}</p><small>Held in page memory only; not written to wizard progress.</small></div>}
        {toolResult !== null && <details className="setup-tool-result"><summary>Sanitized tool result</summary><pre>{JSON.stringify(toolResult, null, 2)}</pre><small>Tool output is untrusted data. Review source and audit details before relying on it.</small></details>}
        <div className="setup-step-actions">
          <Button variant="outline" disabled={progress.stepIndex === 0} onClick={() => setStep(progress.stepIndex - 1)}><ArrowLeft size={14} /> Previous</Button>
          <div><Button variant="outline" onClick={skipCurrentStep}>Skip for now</Button><Button variant="outline" onClick={testStep} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Mic size={14} />} Test step</Button><Button onClick={() => setStep(progress.stepIndex + 1)} disabled={progress.stepIndex === WIZARD_STEPS.length - 1}>Save and continue <ArrowRight size={14} /></Button></div>
        </div>
      </Panel>
    </div>

    {currentStep.id === "readiness" && <ReadinessDashboard checks={checks} evidence={progress.evidence} backendStatus={backend.data?.status} eventConnection={eventConnection} />}

    <Panel className="setup-checks-panel">
      <div className="settings-section-title"><span><Badge tone="cyan">22 checks</Badge></span><div><h2>Capability validation</h2><p>PASS is recorded only after a real test succeeds. Configure opens the relevant setup step; Reset clears evidence, not backend settings or grants.</p></div></div>
      <div className="setup-check-list">{checks.map((check) => <CheckRow key={check.id} check={check} evidence={progress.evidence[check.id]} onConfigure={() => configureCheck(check.id)} onTest={() => testCheck(check.id)} onReset={() => clearEvidence(check.id)} busy={busy} />)}</div>
    </Panel>

    <div className="setup-footer"><Button variant="outline" onClick={() => download("text")}><ArrowDownToLine size={14} /> Text report</Button><Button variant="outline" onClick={resetPreference}>Reset wizard evidence</Button><Link to="/settings" className="text-link"><ArrowLeft size={14} /> Settings</Link></div>
  </div>;
}

function RuntimeConfigurationEditor({
  stepId,
  onSpeechPreference,
  onConfigurationChanged,
}: {
  stepId: WizardStepId;
  onSpeechPreference: (patch: Partial<BrowserSetupProgress["preferences"]>) => void;
  onConfigurationChanged: () => void;
}) {
  const query = useQuery({
    queryKey: ["runtime-configuration"],
    queryFn: ({ signal }) => api.runtimeConfiguration(signal),
  });
  const [draft, setDraft] = useState<RuntimeConfiguration | null>(null);
  const [revision, setRevision] = useState("");
  const [restartRequired, setRestartRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [issues, setIssues] = useState<RuntimeConfigurationIssue[]>([]);
  const [workspacePath, setWorkspacePath] = useState("");
  const [gitPath, setGitPath] = useState("");
  const [websiteOrigin, setWebsiteOrigin] = useState("");
  const [applicationName, setApplicationName] = useState("");
  const [applicationPath, setApplicationPath] = useState("");

  useEffect(() => {
    if (query.data && draft === null) {
      setDraft(query.data.configuration);
      setRevision(query.data.revision);
      setRestartRequired(query.data.restartRequired);
    }
  }, [query.data, draft]);

  const configurableSteps = new Set<WizardStepId>([
    "llm", "stt", "tts", "search", "weather", "workspace", "git",
    "applications", "retention", "permissions",
  ]);

  function updateLlm(patch: Partial<RuntimeConfiguration["llm"]>) {
    setDraft((current) => current ? { ...current, llm: { ...current.llm, ...patch } } : current);
  }

  function updateStt(patch: Partial<RuntimeConfiguration["stt"]>) {
    setDraft((current) => current ? { ...current, stt: { ...current.stt, ...patch } } : current);
  }

  function updateTts(patch: Partial<RuntimeConfiguration["tts"]>) {
    setDraft((current) => current ? { ...current, tts: { ...current.tts, ...patch } } : current);
  }

  function addWorkspaceRoot(path: string) {
    const normalized = path.trim();
    if (!normalized) return;
    setDraft((current) => current ? {
      ...current,
      workspace: {
        ...current.workspace,
        approvedRoots: [...new Set([...current.workspace.approvedRoots, normalized])],
      },
    } : current);
    if (path === workspacePath) setWorkspacePath("");
    if (path === gitPath) setGitPath("");
    setIssues([]);
  }

  async function validateDraft(): Promise<boolean> {
    if (!draft) return false;
    setBusy(true);
    setIssues([]);
    setMessage("Validating this profile with the backend…");
    try {
      const result = await api.validateRuntimeConfiguration(draft);
      setIssues(result.issues);
      setMessage(result.valid ? "Backend validation passed. This does not test provider connectivity." : "Resolve the listed configuration issues before saving.");
      return result.valid;
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Configuration validation failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function testProvider(component: "llm" | "stt") {
    if (!draft) return;
    setBusy(true);
    setIssues([]);
    setMessage(`Testing the selected ${component.toUpperCase()} provider now. This may contact the configured endpoint.`);
    try {
      const result = await api.testRuntimeProvider(component, draft);
      setIssues(result.issues ?? []);
      setMessage(`${component.toUpperCase()} test: ${result.status}. ${result.message ?? ""}`.trim());
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Provider test failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (!draft || !revision) return;
    const valid = await validateDraft();
    if (!valid) return;
    setBusy(true);
    try {
      const result = await api.saveRuntimeConfiguration(draft, revision);
      if (!result.saved) {
        setIssues(result.issues ?? []);
        setMessage("Configuration was not saved. Resolve the listed issues.");
        return;
      }
      if (result.revision) setRevision(result.revision);
      setRestartRequired(Boolean(result.restartRequired));
      onConfigurationChanged();
      setMessage("Configuration saved to the user data directory. Restart the owned JARVIS profile before relying on it.");
      await query.refetch();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Configuration save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rollbackDraft() {
    if (!revision) return;
    setBusy(true);
    try {
      const result = await api.rollbackRuntimeConfiguration(revision);
      setRevision(result.revision);
      setRestartRequired(result.restartRequired);
      onConfigurationChanged();
      setMessage("The previous configuration was restored. Restart the owned JARVIS profile to apply it.");
      const refreshed = await query.refetch();
      setDraft(refreshed.data?.configuration ?? null);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Configuration rollback failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!configurableSteps.has(stepId)) return null;
  if (query.isLoading || !draft) {
    return <div className="setup-config-editor" role="status">{query.isError ? query.error.message : "Loading the user-level configuration profile…"}</div>;
  }

  const fields = <>
    {stepId === "llm" && <section className="setup-config-section" aria-labelledby="config-llm-title">
      <h3 id="config-llm-title">Which LLM do you want to use?</h3>
      <label className="setup-field">Provider<select value={draft.llm.provider} onChange={(event) => updateLlm({ provider: event.target.value as RuntimeConfiguration["llm"]["provider"] })}><option value="unconfigured">Not configured</option><option value="local_openai_compatible">Local OpenAI-compatible</option><option value="azure_openai">Azure OpenAI</option><option value="other_openai_compatible">Other OpenAI-compatible</option></select></label>
      {draft.llm.provider !== "unconfigured" && <>
        <label className="setup-field">Endpoint<input value={draft.llm.endpoint ?? ""} maxLength={2048} placeholder="https://provider.example/v1" onChange={(event) => updateLlm({ endpoint: event.target.value || null })} /></label>
        <label className="setup-field">Model or deployment<input value={draft.llm.model ?? ""} maxLength={200} onChange={(event) => updateLlm({ model: event.target.value || null })} /></label>
        {draft.llm.provider === "azure_openai" && <label className="setup-field">API version<input value={draft.llm.apiVersion ?? ""} maxLength={80} onChange={(event) => updateLlm({ apiVersion: event.target.value || null })} /></label>}
        <label className="setup-field">Authentication<select value={draft.llm.authentication} onChange={(event) => updateLlm({ authentication: event.target.value as RuntimeConfiguration["llm"]["authentication"], secretEnvVar: event.target.value === "none" ? null : draft.llm.secretEnvVar })}><option value="none">No API key</option><option value="environment">Backend environment variable</option></select></label>
        {draft.llm.authentication === "environment" && <label className="setup-field">Secret environment-variable name<input value={draft.llm.secretEnvVar ?? ""} maxLength={128} autoComplete="off" spellCheck={false} placeholder="JARVIS_LLM_API_KEY" onChange={(event) => updateLlm({ secretEnvVar: event.target.value || null })} /></label>}
        <label className="setup-field">Timeout (seconds)<input type="number" min="1" max="120" value={draft.llm.timeoutSeconds} onChange={(event) => updateLlm({ timeoutSeconds: Number(event.target.value) })} /></label>
        <label className="setup-field">Maximum output tokens<input type="number" min="1" max="16384" value={draft.llm.maxOutputTokens} onChange={(event) => updateLlm({ maxOutputTokens: Number(event.target.value) })} /></label>
        <Button variant="outline" disabled={busy} onClick={() => void testProvider("llm")}><RotateCcw size={14} /> Test LLM connection</Button>
      </>}
      <p>OpenAI-compatible LLM endpoints may use HTTP, but traffic is unencrypted and can expose prompts and credentials. Azure OpenAI requires HTTPS. Enter a secret reference name, never a key value.</p>
    </section>}

    {stepId === "stt" && <section className="setup-config-section" aria-labelledby="config-stt-title">
      <h3 id="config-stt-title">Which speech-to-text provider do you want?</h3>
      <label className="setup-field">Provider<select value={draft.stt.provider} onChange={(event) => updateStt({ provider: event.target.value as RuntimeConfiguration["stt"]["provider"] })}><option value="unconfigured">Not configured</option><option value="faster_whisper">Local faster-whisper</option><option value="azure">Azure Speech</option><option value="openai_compatible" disabled>Generic remote STT (adapter unavailable)</option></select></label>
      {draft.stt.provider === "faster_whisper" && <>
        <label className="setup-field">Existing model directory<input value={draft.stt.modelPath ?? ""} maxLength={2048} placeholder="Absolute path; no download is performed" onChange={(event) => updateStt({ modelPath: event.target.value || null })} /></label>
        <label className="setup-field">Model name<input value={draft.stt.model ?? ""} maxLength={200} onChange={(event) => updateStt({ model: event.target.value || null })} /></label>
        <label className="setup-field">Device<select value={draft.stt.device} onChange={(event) => updateStt({ device: event.target.value as RuntimeConfiguration["stt"]["device"] })}><option value="cpu">CPU</option><option value="cuda">CUDA</option><option value="auto">Automatic</option></select></label>
        <label className="setup-field">Compute type<select value={draft.stt.computeType} onChange={(event) => updateStt({ computeType: event.target.value as RuntimeConfiguration["stt"]["computeType"] })}><option value="int8">int8</option><option value="int8_float16">int8 / float16</option><option value="float16">float16</option><option value="float32">float32</option></select></label>
      </>}
      {draft.stt.provider === "azure" && <>
        <label className="setup-field">Azure region<input value={draft.stt.region ?? ""} maxLength={80} onChange={(event) => updateStt({ region: event.target.value || null })} /></label>
        <label className="setup-field">Secret environment-variable name<input value={draft.stt.secretEnvVar ?? ""} maxLength={128} autoComplete="off" spellCheck={false} placeholder="JARVIS_AZURE_SPEECH_KEY" onChange={(event) => updateStt({ secretEnvVar: event.target.value || null })} /></label>
      </>}
      <label className="setup-field">Language<input value={draft.stt.language} maxLength={16} onChange={(event) => updateStt({ language: event.target.value })} /></label>
      {draft.stt.provider !== "unconfigured" && <Button variant="outline" disabled={busy} onClick={() => void testProvider("stt")}><Mic size={14} /> Test STT provider</Button>}
      <p>No model downloads or disk searches are performed. Generic remote STT is not available in this runtime.</p>
    </section>}

    {stepId === "tts" && <section className="setup-config-section" aria-labelledby="config-tts-title">
      <h3 id="config-tts-title">How should JARVIS speak?</h3>
      <label className="setup-field">Provider<select value={draft.tts.provider} onChange={(event) => updateTts({ provider: event.target.value as RuntimeConfiguration["tts"]["provider"] })}><option value="browser">Browser-local speech</option><option value="unconfigured">Not configured</option><option value="piper" disabled>Piper (adapter unavailable)</option><option value="azure" disabled>Azure TTS (adapter unavailable)</option></select></label>
      <label className="setup-field">Language<input value={draft.tts.language} maxLength={16} onChange={(event) => { updateTts({ language: event.target.value }); onSpeechPreference({ language: event.target.value }); }} /></label>
      <label className="setup-field">Voice identifier<input value={draft.tts.voice} maxLength={512} onChange={(event) => { updateTts({ voice: event.target.value }); onSpeechPreference({ voiceURI: event.target.value }); }} /></label>
      <label className="setup-field">Rate<input type="range" min="0.5" max="2" step="0.1" value={draft.tts.rate} onChange={(event) => { const rate = Number(event.target.value); updateTts({ rate }); onSpeechPreference({ speechRate: rate }); }} /></label>
      <label className="setup-field">Volume<input type="range" min="0" max="1" step="0.1" value={draft.tts.volume} onChange={(event) => { const volume = Number(event.target.value); updateTts({ volume }); onSpeechPreference({ speechVolume: volume }); }} /></label>
      <p>Browser-local playback is supported. Piper and Azure TTS do not have runtime adapters in this build.</p>
    </section>}

    {stepId === "search" && <section className="setup-config-section" aria-labelledby="config-search-title">
      <h3 id="config-search-title">Which search provider should be used?</h3>
      <label className="setup-field">Provider<select value={draft.search.provider} onChange={(event) => setDraft((current) => current ? { ...current, search: { ...current.search, provider: event.target.value as RuntimeConfiguration["search"]["provider"] } } : current)}><option value="unconfigured">No web search</option><option value="brave">Brave Search</option></select></label>
      {draft.search.provider === "brave" && <label className="setup-field">Secret environment-variable name<input value={draft.search.secretEnvVar ?? ""} maxLength={128} autoComplete="off" spellCheck={false} placeholder="JARVIS_WEB_SEARCH_API_KEY" onChange={(event) => setDraft((current) => current ? { ...current, search: { ...current.search, secretEnvVar: event.target.value || null } } : current)} /></label>}
      <label className="setup-field">Result limit<input type="number" min="1" max="20" value={draft.search.resultLimit} onChange={(event) => setDraft((current) => current ? { ...current, search: { ...current.search, resultLimit: Number(event.target.value) } } : current)} /></label>
      <p>Only the environment-variable name is saved. Search queries are never sent during configuration or validation.</p>
    </section>}

    {stepId === "weather" && <section className="setup-config-section" aria-labelledby="config-weather-title">
      <h3 id="config-weather-title">Where should weather default to?</h3>
      <label className="setup-field">Provider<select value={draft.weather.provider} onChange={(event) => setDraft((current) => current ? { ...current, weather: { ...current.weather, provider: event.target.value as RuntimeConfiguration["weather"]["provider"] } } : current)}><option value="open_meteo">Open-Meteo</option><option value="unconfigured">Disable weather</option></select></label>
      <label className="setup-field">Default location<input value={draft.weather.defaultLocation} maxLength={160} placeholder="City and country" onChange={(event) => setDraft((current) => current ? { ...current, weather: { ...current.weather, defaultLocation: event.target.value } } : current)} /></label>
      <label className="setup-field">Temperature<select value={draft.weather.temperatureUnit} onChange={(event) => setDraft((current) => current ? { ...current, weather: { ...current.weather, temperatureUnit: event.target.value as RuntimeConfiguration["weather"]["temperatureUnit"] } } : current)}><option value="celsius">Celsius</option><option value="fahrenheit">Fahrenheit</option></select></label>
      <label className="setup-field">Timezone<input value={draft.weather.timezone} maxLength={64} onChange={(event) => setDraft((current) => current ? { ...current, weather: { ...current.weather, timezone: event.target.value } } : current)} /></label>
      <p>A location query is sent only when you run the separate live weather test.</p>
    </section>}

    {stepId === "workspace" && <section className="setup-config-section" aria-labelledby="config-workspace-title">
      <h3 id="config-workspace-title">Which folders may backend file tools access?</h3>
      <p>Enter an absolute directory path you own. Saving explicitly approves it for this JARVIS profile; the browser folder picker cannot grant backend access.</p>
      <label className="setup-field">Absolute folder path<input value={workspacePath} maxLength={2048} placeholder="C:\\Users\\you\\Documents\\project" onChange={(event) => setWorkspacePath(event.target.value)} /></label>
      <Button variant="outline" onClick={() => addWorkspaceRoot(workspacePath)}>Add approved folder</Button>
      {draft.workspace.approvedRoots.map((root) => <div className="setup-config-list-row" key={root}><code>{root}</code><Button size="small" variant="outline" onClick={() => setDraft((current) => current ? { ...current, workspace: { ...current.workspace, approvedRoots: current.workspace.approvedRoots.filter((item) => item !== root) } } : current)}>Remove</Button></div>)}
      <label className="setup-field">Allowed extensions<input value={draft.workspace.allowedFileTypes.join(", ")} maxLength={800} onChange={(event) => setDraft((current) => current ? { ...current, workspace: { ...current.workspace, allowedFileTypes: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) } } : current)} /></label>
      <label className="setup-field">Maximum file size (KiB)<input type="number" min="1" max="8192" value={Math.round(draft.workspace.maxFileBytes / 1024)} onChange={(event) => setDraft((current) => current ? { ...current, workspace: { ...current.workspace, maxFileBytes: Number(event.target.value) * 1024 } } : current)} /></label>
    </section>}

    {stepId === "git" && <section className="setup-config-section" aria-labelledby="config-git-title">
      <h3 id="config-git-title">Which repository should read-only Git tools use?</h3>
      <p>Choose an existing repository directory by entering its absolute path. It is added to the same backend-approved roots as workspace tools; no disk discovery occurs.</p>
      <label className="setup-field">Repository directory<input value={gitPath} maxLength={2048} placeholder="C:\\Users\\you\\source\\project" onChange={(event) => setGitPath(event.target.value)} /></label>
      <Button variant="outline" onClick={() => addWorkspaceRoot(gitPath)}>Approve repository root</Button>
      <p>Git status/diff/log operations remain read-only. Writes, commits, pushes, resets, and shell commands are not enabled.</p>
    </section>}

    {stepId === "applications" && <section className="setup-config-section" aria-labelledby="config-applications-title">
      <h3 id="config-applications-title">Which websites and applications are approved?</h3>
      <label className="setup-field">HTTPS website origin<input value={websiteOrigin} maxLength={512} placeholder="https://example.com" onChange={(event) => setWebsiteOrigin(event.target.value)} /></label>
      <Button variant="outline" onClick={() => { const origin = websiteOrigin.trim().replace(/\/$/, ""); if (origin) setDraft((current) => current ? { ...current, permissions: { ...current.permissions, approvedWebsites: [...new Set([...current.permissions.approvedWebsites, origin])] } } : current); setWebsiteOrigin(""); }}>Add website origin</Button>
      {draft.permissions.approvedWebsites.map((origin) => <div className="setup-config-list-row" key={origin}><code>{origin}</code><Button size="small" variant="outline" onClick={() => setDraft((current) => current ? { ...current, permissions: { ...current.permissions, approvedWebsites: current.permissions.approvedWebsites.filter((item) => item !== origin) } } : current)}>Remove</Button></div>)}
      <label className="setup-field">Application ID<input value={applicationName} maxLength={64} placeholder="editor" onChange={(event) => setApplicationName(event.target.value)} /></label>
      <label className="setup-field">Absolute executable path<input value={applicationPath} maxLength={2048} placeholder="C:\\Program Files\\Editor\\editor.exe" onChange={(event) => setApplicationPath(event.target.value)} /></label>
      <Button variant="outline" onClick={() => { if (applicationName.trim() && applicationPath.trim()) setDraft((current) => current ? { ...current, permissions: { ...current.permissions, approvedApplications: { ...current.permissions.approvedApplications, [applicationName.trim()]: applicationPath.trim() } } } : current); setApplicationName(""); setApplicationPath(""); }}>Add application path</Button>
      {Object.entries(draft.permissions.approvedApplications).map(([name, path]) => <div className="setup-config-list-row" key={name}><code>{name}: {path}</code><Button size="small" variant="outline" onClick={() => setDraft((current) => { if (!current) return current; const approvedApplications = { ...current.permissions.approvedApplications }; delete approvedApplications[name]; return { ...current, permissions: { ...current.permissions, approvedApplications } }; })}>Remove</Button></div>)}
      <p>Application paths are prepared for an owned desktop runtime. Browser mode cannot launch programs. Website origins must be HTTPS and still obey tool permission checks.</p>
    </section>}

    {stepId === "retention" && <section className="setup-config-section" aria-labelledby="config-retention-title">
      <h3 id="config-retention-title">Review data retention</h3>
      <label className="setup-field">Raw audio retention<input type="checkbox" checked={false} disabled readOnly /></label>
      <p>Raw audio retention is fixed off. Conversation/database retention controls are not implemented in this runtime; no retention period is claimed or changed here.</p>
    </section>}

    {stepId === "permissions" && <section className="setup-config-section" aria-labelledby="config-permissions-title">
      <h3 id="config-permissions-title">How should ungranted actions be handled?</h3>
      <label className="setup-field">Default permission mode<select value={draft.permissions.defaultMode} onChange={(event) => setDraft((current) => current ? { ...current, permissions: { ...current.permissions, defaultMode: event.target.value as RuntimeConfiguration["permissions"]["defaultMode"] } } : current)}><option value="ask_every_time">Ask every time</option><option value="deny">Deny unless explicitly granted</option></select></label>
      <p>Existing confirmation and grant controls remain authoritative. Saving this profile does not create a grant or approve an action.</p>
    </section>}
  </>;

  return <div className="setup-config-editor">
    {fields}
    {issues.length > 0 && <ul className="setup-config-issues" role="alert">{issues.map((issue, index) => <li key={`${issue.path}-${index}`}><strong>{issue.path}</strong>: {issue.message}</li>)}</ul>}
    {message && <p className="setup-config-message" role="status">{message}</p>}
    <div className="setup-config-actions">
      <Button variant="outline" onClick={() => void validateDraft()} disabled={busy}>Validate profile</Button>
      <Button onClick={() => void saveDraft()} disabled={busy || !revision}>Save configuration</Button>
      {restartRequired && <Button variant="outline" onClick={() => void rollbackDraft()} disabled={busy}>Rollback last save</Button>}
    </div>
    <small>Saved profiles contain provider settings and secret-reference names only. Restart is required; the running backend does not hot-reload providers.</small>
  </div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="setup-fact"><span>{label}</span><strong title={value}>{value}</strong></div>;
}

type StepContentProps = {
  stepId: WizardStepId;
  backendStatus: string;
  backendMessage: string;
  eventConnection: string;
  installStatus: ReturnType<typeof pwaInstallAvailability>;
  microphonePermission: PermissionState | "unknown" | "unsupported";
  notificationPermission: NotificationPermission | "unsupported";
  features: ReturnType<typeof browserFeatures>;
  llmStatus: string;
  llmMessage: string;
  sttStatus: string;
  sttMessage: string;
  wakeMessage: string;
  tools: ToolListing[];
  grantsCount?: number;
  auditCount?: number;
  preferences: BrowserSetupProgress["preferences"];
  voices: SpeechSynthesisVoice[];
  voiceLabel: string;
  weatherTool?: ToolListing;
  searchTool?: ToolListing;
  approvedWorkspaces: Array<{ workspace_id: string; display_name: string }>;
  selectedWorkspaceId: string;
  relativePath: string;
  fetchUrl: string;
  audioInputCount: number | null;
  weatherLocation: string;
  searchQuery: string;
  directoryName: string;
  directoryReadSummary: string;
  transcript: string;
  toolResult: unknown;
  message: string;
  error: string;
  busy: boolean;
  ttsPlaying: boolean;
  onTestHealth: () => void;
  onTestMicrophone: () => void;
  onTestStt: () => void;
  onTestTts: () => void;
  onStopTts: () => void;
  onTestLlm: () => void;
  onTestToolHealth: (toolId: string, ids: string[]) => void;
  onExecuteTool: (toolId: string, args: Record<string, unknown>, id: string) => void;
  onTestDirectory: () => void;
  onTestTextFile: () => void;
  onRequestNotifications: () => void;
  onTestNotification: () => void;
  onTestGrants: () => void;
  onListWorkspaces: () => void;
  onListWorkspaceFiles: () => void;
  onReadWorkspaceTextFile: () => void;
  onGitStatus: () => void;
  onFetchPage: () => void;
  onInstallPwa: () => void;
  onWorkspaceSelect: (id: string) => void;
  onRelativePath: (path: string) => void;
  onFetchUrl: (url: string) => void;
  onConfigure: () => void;
  onSpeechPreference: (patch: Partial<BrowserSetupProgress["preferences"]>) => void;
  onWeatherLocation: (value: string) => void;
  onSearchQuery: (value: string) => void;
  onSetMessage: (value: string) => void;
};

function StepContent(props: StepContentProps) {
  const link = (to: string, label: string) => <Link className="text-link" to={to}>{label} <ExternalLink size={13} /></Link>;
  switch (props.stepId) {
    case "connection": return <div className="setup-step-content"><Fact label="Browser profile" value={`${deploymentMode()} · ${window.location.origin}`} /><Fact label="Backend health" value={`${props.backendStatus} · ${props.backendMessage}`} /><Fact label="Authenticated WebSocket" value={props.eventConnection} /><p>Only the current loopback origin and its short-lived browser session are used. This test does not trust forwarded headers.</p><div className="setup-inline-actions"><Button onClick={props.onTestHealth} disabled={props.busy}><RotateCcw size={14} /> Test backend and event stream</Button>{props.installStatus === "available" && <Button variant="outline" onClick={props.onInstallPwa} disabled={props.busy}>Install PWA</Button>}</div></div>;
    case "data": return <div className="setup-step-content"><p><strong>Current limitation:</strong> this renderer cannot inspect the backend process environment or switch its data directory while running. No machine or disk scan is performed.</p><p>Default location is the user-writable JARVIS data directory under LocalAppData. To choose another user-owned folder, set <code>JARVIS_DATA_DIR</code> in the same PowerShell session before starting the owned browser profile. A restart is required; do not use protected system paths.</p><p>Administrator access: no. The selected location must be writable by your account. Existing database/audit data is not moved automatically.</p><Button variant="outline" onClick={props.onConfigure}>Show user-level configuration</Button></div>;
    case "microphone": return <div className="setup-step-content"><Fact label="Microphone API" value={props.features.microphone ? "supported" : "unsupported"} /><Fact label="MediaRecorder" value={props.features.mediaRecorder ? "supported" : "unsupported"} /><Fact label="Permission state" value={props.microphonePermission} /><Fact label="Input devices" value={props.audioInputCount === null ? "not enumerated until permission" : String(props.audioInputCount)} /><p>Test requests permission only after activation, opens a live audio track, then immediately stops it. It does not save or upload audio.</p><Button onClick={props.onTestMicrophone} disabled={props.busy || !props.features.microphone || !props.features.mediaRecorder}><Mic size={14} /> Request and test microphone</Button></div>;
    case "stt": return <div className="setup-step-content"><Fact label="Provider" value={props.sttStatus} /><p>{props.sttMessage}</p><p>Test captures a short clip after your action, sends it to the configured backend provider, shows the transcript only in this page, and releases temporary audio. If unconfigured, ask the operator to select the approved local faster-whisper model or remote provider. Never paste an API key here.</p><Button onClick={props.onTestStt} disabled={props.busy || props.sttStatus !== "healthy"}><Mic size={14} /> Record and transcribe</Button>{props.sttStatus !== "healthy" && <p className="setup-limitation">A real transcription test is disabled until backend STT health is healthy.</p>}</div>;
    case "tts": return <div className="setup-step-content"><Fact label="SpeechSynthesis" value={props.features.speechSynthesis ? `${props.voices.length} local voices` : "unsupported"} /><label className="setup-field">Local voice<select value={props.preferences.voiceURI} onChange={(event) => props.onSpeechPreference({ voiceURI: event.target.value })}><option value="">Automatic local voice</option>{props.voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>)}</select></label><label className="setup-field">Language<input value={props.preferences.language} maxLength={16} onChange={(event) => props.onSpeechPreference({ language: event.target.value })} /></label><label className="setup-field">Rate <span>{props.preferences.speechRate.toFixed(1)}x</span><input type="range" min="0.5" max="2" step="0.1" value={props.preferences.speechRate} onChange={(event) => props.onSpeechPreference({ speechRate: Number(event.target.value) })} /></label><label className="setup-field">Volume <span>{Math.round(props.preferences.speechVolume * 100)}%</span><input type="range" min="0" max="1" step="0.1" value={props.preferences.speechVolume} onChange={(event) => props.onSpeechPreference({ speechVolume: Number(event.target.value) })} /></label><div className="setup-inline-actions"><Button onClick={props.onTestTts} disabled={!props.voices.length || props.ttsPlaying}><Volume2 size={14} /> Test local speech</Button><Button variant="outline" onClick={props.onStopTts} disabled={!props.ttsPlaying}>Stop playback</Button></div><small>Voice choice, rate, volume, language, and timezone are the only user preferences persisted here. No credentials are stored.</small></div>;
    case "llm": return <div className="setup-step-content"><Fact label="Configured provider health" value={props.llmStatus} /><p>{props.llmMessage}</p><p>Run one explicit minimal inference to measure latency. This creates a command-history and audit entry. If healthy provider metadata identifies a mock, inference is not sent and status cannot pass. The backend does not identify local versus external provider type, so inference evidence is reported here without marking either provider-specific check PASS. Structured output/tool-calling compatibility are not tested by this safe direct-response probe.</p><p>Provider configuration remains backend-owned. For OpenAI-compatible setup, the operator uses <code>JARVIS_LLM_PROVIDER</code>, <code>JARVIS_LLM_BASE_URL</code>, <code>JARVIS_LLM_MODEL</code>, and secret source <code>JARVIS_LLM_API_KEY</code>. Azure uses <code>JARVIS_AZURE_OPENAI_ENDPOINT</code>, <code>JARVIS_AZURE_OPENAI_DEPLOYMENT</code>, <code>JARVIS_AZURE_OPENAI_API_VERSION</code>, and secret source <code>JARVIS_AZURE_OPENAI_API_KEY</code>. Never paste key values here; use an approved backend environment/secret source. Configuration changes require a JARVIS-owned restart.</p><Button onClick={props.onTestLlm} disabled={props.busy}><RotateCcw size={14} /> Test health and minimal inference</Button>{link("/settings#providers", "Provider status")}</div>;
    case "wake": return <div className="setup-step-content"><Fact label="Wake provider" value={props.wakeMessage} /><Fact label="Page-focused shortcut" value={loadBrowserShortcutPreferences().enabled ? loadBrowserShortcutPreferences().shortcut : "disabled"} /><p>Configure safe browser defaults: Ctrl+Space for page-focused push-to-talk, wake-word monitoring off, audio retention off. Browser mode cannot run a global shortcut or continue wake listening after this page closes.</p><Button onClick={props.onConfigure}><Check size={14} /> Apply browser push-to-talk defaults</Button>{link("/settings#deployment-controls", "Voice settings")}</div>;
    case "search": return <div className="setup-step-content"><p>Select and configure one supported web-search provider. The secret stays in the backend environment; enter only its environment-variable name.</p></div>;
    case "weather": return <div className="setup-step-content"><p>Choose a default location, temperature unit, and timezone. A live lookup is separate and runs only after you activate it.</p></div>;
    case "live-tests": return <div className="setup-step-content"><p>Registered tools: {props.tools.length}. Live provider queries run only after you activate each test.</p><div className="setup-provider-test"><strong>Weather · Open-Meteo</strong><p>{props.weatherTool ? "Enabled tool is registered. Enter a city only when you choose to run a real lookup." : "Weather tool is not enabled/registered."}</p><label className="setup-field">Location for this test<input value={props.weatherLocation} maxLength={160} placeholder="Example: Bengaluru, India" onChange={(event) => props.onWeatherLocation(event.target.value)} /></label><Button onClick={() => props.onExecuteTool("web.weather", { location: props.weatherLocation.trim() }, "weather")} disabled={!props.weatherTool || !props.weatherLocation.trim() || props.busy}>Run live weather lookup</Button></div><div className="setup-provider-test"><strong>Web search</strong><p>{props.searchTool ? "Search tool is enabled; provider health does not prove live search." : "Search requires an operator-configured provider and credential. Mock search is never accepted as PASS."}</p><label className="setup-field">Harmless current-information query<input value={props.searchQuery} maxLength={300} onChange={(event) => props.onSearchQuery(event.target.value)} /></label><Button onClick={() => props.onExecuteTool("web.search", { query: props.searchQuery.trim() }, "web_search")} disabled={!props.searchTool || !props.searchQuery.trim() || props.busy}>Run live search</Button></div><div className="setup-provider-test"><strong>Approved webpage retrieval</strong><p>Enter a credential-free HTTPS URL. The backend enforces its exact approved-origin list; an unapproved URL is denied.</p><label className="setup-field">Approved HTTPS URL<input value={props.fetchUrl} maxLength={2048} placeholder="https://approved.example/page" onChange={(event) => props.onFetchUrl(event.target.value)} /></label><Button onClick={props.onFetchPage} disabled={props.busy || !props.fetchUrl.trim()}>Fetch approved page</Button></div>{link("/tools", "Review tool configuration and permissions")}</div>;
    case "workspace": return <div className="setup-step-content"><p>Choose only a folder you explicitly approve. JARVIS reads no other folder. Browser access is temporary and does not grant backend workspace access.</p><div className="setup-inline-actions"><Button onClick={props.onTestDirectory}><FolderOpen size={14} /> Choose and list selected folder</Button><Button variant="outline" onClick={props.onTestTextFile}>Read selected harmless text file</Button><Button variant="outline" onClick={props.onListWorkspaces} disabled={props.busy}>List backend-approved workspaces</Button></div>{props.directoryName && <Fact label="Selected folder" value={`${props.directoryName} (page memory only)`} />}{props.directoryReadSummary && <p>{props.directoryReadSummary}</p>}{props.approvedWorkspaces.length > 0 && <><label className="setup-field">Approved backend workspace<select value={props.selectedWorkspaceId} onChange={(event) => props.onWorkspaceSelect(event.target.value)}>{props.approvedWorkspaces.map((workspace) => <option key={workspace.workspace_id} value={workspace.workspace_id}>{workspace.display_name}</option>)}</select></label><div className="setup-inline-actions"><Button variant="outline" onClick={props.onListWorkspaceFiles} disabled={props.busy}>List approved workspace entries</Button><label className="setup-field">Relative text file path<input value={props.relativePath} maxLength={4096} placeholder="notes/readme.txt" onChange={(event) => props.onRelativePath(event.target.value)} /></label><Button variant="outline" onClick={props.onReadWorkspaceTextFile} disabled={props.busy}>Read selected .txt or .md</Button></div></>}<p>Backend containment and read/write scopes remain operator-approved and must be tested with the actual tools.</p>{link("/tools", "Open backend filesystem tool tests")}</div>;
    case "git": return <div className="setup-step-content"><p>Repository discovery is limited to backend-approved workspace roots. This browser does not scan disk or infer repositories.</p><p>Selected approved workspace: {props.approvedWorkspaces.find((workspace) => workspace.workspace_id === props.selectedWorkspaceId)?.display_name ?? "none"}. The test invokes fixed read-only <code>git status</code>; it cannot commit, push, reset, or modify files.</p><Button onClick={props.onGitStatus} disabled={props.busy || !props.selectedWorkspaceId}>Test real Git status</Button>{link("/tools", "Open Tools & Skills")}</div>;
    case "applications": return <div className="setup-step-content"><Badge tone="neutral">UNSUPPORTED IN BROWSER</Badge><p>Browser mode cannot launch Windows applications, and the browser cannot configure backend executable allowlists. Use an approved website or open an approved project folder manually.</p><p>Administrator access is not requested. No executable paths are scanned.</p>{link("/tools", "Review available developer tools")}</div>;
    case "notifications": return <div className="setup-step-content"><Fact label="Notification API" value={props.features.notifications ? "supported" : "unsupported"} /><Fact label="Browser permission" value={props.notificationPermission} /><p>Configure requests permission only after your click. Test creates one neutral notification and closes it after five seconds. In-app notices continue to work if browser notifications are denied.</p><div className="setup-inline-actions"><Button onClick={props.onRequestNotifications} disabled={!props.features.notifications || props.notificationPermission === "granted"}>Request permission</Button><Button variant="outline" onClick={props.onTestNotification} disabled={props.notificationPermission !== "granted"}>Send test notification</Button></div></div>;
    case "retention": return <div className="setup-step-content"><Fact label="Raw audio retention" value="Disabled by default; this wizard cannot enable it." /><Fact label="Timezone" value={Intl.DateTimeFormat().resolvedOptions().timeZone || "not exposed"} /><p>Conversation, audit, database, and retention settings are backend-owned. The renderer does not receive retention configuration or data-directory paths. Browser wizard progress contains only step IDs, statuses, fixed evidence codes, timestamps, and non-secret speech preferences.</p><Button variant="outline" onClick={props.onConfigure}>Show user-level restart boundary</Button></div>;
    case "permissions": return <div className="setup-step-content"><Fact label="Active grants read" value={props.grantsCount === undefined ? "not available" : String(props.grantsCount)} /><Fact label="Recent audit records read" value={props.auditCount === undefined ? "not available" : String(props.auditCount)} /><p>This test reads only. It does not create a grant, approve an action, or change the default permission mode. Use the existing backend tool sandbox for a real permission request and decide explicitly in its confirmation dialog.</p><Button onClick={props.onTestGrants} disabled={props.busy}>Test grants and audit read</Button>{link("/tools", "Review grants and tool scopes")}</div>;
    case "voice-command": return <div className="setup-step-content"><p>1. Open Command Center. 2. Activate push-to-talk and say “Jarvis, tell me the current time.” 3. Confirm the transcript, plan, current-time tool, permission/audit outcome, visible response, and local speech. 4. Stop playback.</p><p>This step cannot be completed by a synthetic transcript or mock. The wizard records no PASS here automatically.</p><Button onClick={props.onConfigure}><Mic size={14} /> Show command test instructions</Button>{link("/", "Open Command Center")}</div>;
    case "readiness": return <div className="setup-step-content"><p>Readiness is computed from live backend state and explicit test evidence. Provider health alone does not count as inference; tool health alone does not count as an execution test.</p><p>Overall status remains CONFIGURATION_REQUIRED until the LLM/STT paths are configured and real tests pass. Browser-only unsupported features remain limitations, not setup failures.</p><Button onClick={props.onTestHealth}>Refresh final checks</Button></div>;
  }
}

function CheckRow({ check, evidence, onConfigure, onTest, onReset, busy }: { check: ValidationCheck; evidence?: BrowserSetupProgress["evidence"][string]; onConfigure: () => void; onTest: () => void; onReset: () => void; busy: boolean }) {
  const guidance = guidanceForCheck(check);
  const tone = check.status === "PASS" ? "green" : check.status === "FAILED" || check.status === "BLOCKED_BY_POLICY" ? "danger" : check.status === "DEGRADED" || check.status === "REQUIRES_CREDENTIALS" || check.status === "REQUIRES_MODEL" || check.status === "REQUIRES_RESTART" ? "amber" : "neutral";
  return <details className="setup-check-row"><summary><span className="setup-check-title"><strong>{check.label}</strong><small>{check.detail}</small></span><span className="setup-check-state"><Badge tone="neutral">{check.requirement.replaceAll("_", " ")}</Badge><Badge tone={tone}>{check.status}</Badge><span>{evidence ? `Tested ${new Date(evidence.testedAt).toLocaleString()}` : "No test evidence"}</span></span></summary><div className="setup-check-details"><dl><div><dt>Why</dt><dd>{guidance.why}</dd></div><div><dt>Missing</dt><dd>{guidance.missing}</dd></div><div><dt>Permission</dt><dd>{guidance.permissions}</dd></div><div><dt>Administrator</dt><dd>{guidance.admin}</dd></div><div><dt>Company policy</dt><dd>{guidance.policy}</dd></div><div><dt>Credentials</dt><dd>{guidance.credentials}</dd></div><div><dt>Model</dt><dd>{guidance.model}</dd></div><div><dt>Troubleshooting</dt><dd>{guidance.troubleshooting}</dd></div><div><dt>Evidence</dt><dd>{evidence ? `${evidence.code} · ${new Date(evidence.testedAt).toISOString()}` : "No successful or failed test recorded."}</dd></div></dl><div className="setup-check-actions"><Button size="small" variant="outline" onClick={onConfigure}>Configure</Button><Button size="small" variant="outline" onClick={onTest} disabled={busy}>Test</Button><Button size="small" variant="outline" onClick={onReset}><RotateCcw size={13} /> Reset evidence</Button></div></div></details>;
}

function ReadinessDashboard({ checks, evidence, backendStatus, eventConnection }: { checks: ValidationCheck[]; evidence: BrowserSetupProgress["evidence"]; backendStatus?: string; eventConnection: string }) {
  const categories = [
    { title: "Core Assistant", ids: ["local_llm", "external_llm", "stt_provider", "tts", "tts_provider"] },
    { title: "Voice", ids: ["voice_input", "push_to_talk", "stt_provider", "wake_word", "tts"] },
    { title: "Tools", ids: ["weather", "web_search", "webpage_retrieval", "workspace_tools", "git_read", "application_launch"] },
    { title: "Security", ids: ["workspace_tools", "git_read"] },
    { title: "Deployment", ids: ["global_shortcut", "system_tray", "background_automation", "scheduled_tasks"] },
  ];
  return <Panel className="setup-readiness-panel"><div className="settings-section-title"><span><CircleHelp size={17} /></span><div><h2>Final readiness dashboard</h2><p>Evidence is timestamped. This report does not decide internal-pilot or production readiness.</p></div></div><div className="setup-readiness-categories">{categories.map((category) => <section key={category.title}><h3>{category.title}</h3>{category.ids.map((id) => { const check = checks.find((item) => item.id === id); if (!check) return null; return <div className="setup-readiness-line" key={id}><strong>{CHECK_LABELS[id] ?? id}</strong><Badge tone={check.status === "PASS" ? "green" : check.status === "FAILED" ? "danger" : "amber"}>{check.status}</Badge><span>{evidence[id] ? new Date(evidence[id].testedAt).toLocaleString() : id === "local_llm" || id === "external_llm" || id === "stt_provider" ? "Configuration source: backend profile/environment" : "Configuration source: browser runtime/backend policy"}</span><small>{check.detail}</small></div>; })}</section>)}</div><div className="setup-readiness-line"><strong>Backend / WebSocket</strong><Badge tone={backendStatus === "healthy" && eventConnection === "connected" ? "green" : "amber"}>{backendStatus ?? "not tested"} / {eventConnection}</Badge><span>{evidence.backend_connection ? new Date(evidence.backend_connection.testedAt).toLocaleString() : "No explicit health test evidence"}</span></div></Panel>;
}


