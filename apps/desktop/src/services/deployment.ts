export type DeploymentMode = "browser" | "pwa" | "electron";

export type CapabilityStatus =
  | "available"
  | "unavailable"
  | "blocked_by_policy"
  | "unconfigured"
  | "degraded"
  | "unsupported";

export type SystemCapability = {
  id: string;
  label: string;
  status: CapabilityStatus;
  detail: string;
};

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

declare global {
  interface Window {
    __jarvisInstallPrompt?: InstallPromptEvent;
    __jarvisWaitingWorker?: ServiceWorker;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event: Event) => {
    event.preventDefault();
    window.__jarvisInstallPrompt = event as InstallPromptEvent;
    window.dispatchEvent(new Event("jarvis-pwa-install-available"));
  });
  window.addEventListener("appinstalled", () => {
    delete window.__jarvisInstallPrompt;
    window.dispatchEvent(new Event("jarvis-pwa-installed"));
  });
}

export function deploymentMode(): DeploymentMode {
  if (typeof window !== "undefined" && window.jarvis?.isElectron) return "electron";
  const configured = import.meta.env.VITE_DEPLOYMENT_MODE ?? import.meta.env.MODE;
  return configured === "browser" || configured === "pwa" ? configured : "electron";
}

export function isBrowserDeployment(): boolean {
  return deploymentMode() !== "electron";
}

export function browserFeatures() {
  const speech = window as Window & {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  return {
    microphone: typeof navigator.mediaDevices?.getUserMedia === "function"
      && typeof window.AudioContext === "function",
    mediaRecorder: typeof MediaRecorder !== "undefined",
    speechRecognition: Boolean(speech.SpeechRecognition ?? speech.webkitSpeechRecognition),
    speechSynthesis: "speechSynthesis" in window,
    notifications: "Notification" in window,
    serviceWorker: "serviceWorker" in navigator,
    secureContext: window.isSecureContext,
    standalone: typeof window.matchMedia === "function"
      && window.matchMedia("(display-mode: standalone)").matches,
  };
}

export function browserCapabilityMatrix(): SystemCapability[] {
  const features = browserFeatures();
  const browserStatus = (available: boolean): CapabilityStatus =>
    available ? "available" : "unsupported";
  const browserVoiceCapture = features.microphone && features.mediaRecorder;
  return [
    { id: "voice_input", label: "Voice input", status: browserStatus(browserVoiceCapture), detail: "Starts only after a user action and microphone permission." },
    { id: "push_to_talk", label: "Push-to-talk", status: browserStatus(browserVoiceCapture), detail: "Available only while this page is open." },
    { id: "wake_word", label: "Wake word", status: "unconfigured", detail: "Uses an explicitly configured backend detector while this page is visible; OS-wide wake is unavailable." },
    { id: "tts", label: "Speech output", status: browserStatus(features.speechSynthesis), detail: "Uses browser-installed voices; output-device selection is unavailable." },
    { id: "web_search", label: "Web search", status: "unconfigured", detail: "Requires an operator-configured backend provider." },
    { id: "weather", label: "Weather", status: "unconfigured", detail: "Requires an enabled backend weather provider." },
    { id: "webpage_retrieval", label: "Approved webpage retrieval", status: "unconfigured", detail: "Requires backend-approved HTTPS origins." },
    { id: "workspace_tools", label: "Workspace file tools", status: "unconfigured", detail: "Requires operator-approved workspace roots and permissions." },
    { id: "git_read", label: "Git read tools", status: "unconfigured", detail: "Requires an approved workspace containing Git metadata." },
    { id: "application_launch", label: "Windows application launch", status: "unsupported", detail: "Browser pages cannot launch local applications." },
    { id: "clipboard", label: "Clipboard", status: "unsupported", detail: "No hidden clipboard access is implemented." },
    { id: "screenshots", label: "Screenshots", status: "unsupported", detail: "No explicit browser capture workflow is implemented." },
    { id: "notifications", label: "Browser notifications", status: browserStatus(features.notifications), detail: "Requires explicit browser permission; in-app notices remain available." },
    { id: "global_shortcut", label: "Global shortcut", status: "unsupported", detail: "Browser shortcuts work only while this page has focus." },
    { id: "system_tray", label: "System tray", status: "unsupported", detail: "Electron-only." },
    { id: "window_controls", label: "Custom window controls", status: "unsupported", detail: "Browser-native window controls are used." },
    { id: "background_automation", label: "Background automation", status: "unsupported", detail: "The page and local backend must remain running." },
    { id: "scheduled_tasks", label: "Scheduled tasks", status: "unsupported", detail: "No OS scheduler or background service is installed." },
    { id: "local_llm", label: "Local LLM", status: "unconfigured", detail: "Requires an operator-configured local OpenAI-compatible endpoint." },
    { id: "external_llm", label: "External LLM", status: "unconfigured", detail: "Requires an explicitly configured backend provider and credentials." },
    { id: "stt_provider", label: "Speech recognition provider", status: "unconfigured", detail: "Requires an explicitly configured backend STT provider; browser SpeechRecognition is not used." },
    { id: "tts_provider", label: "Speech output provider", status: browserStatus(features.speechSynthesis), detail: "Browser speech synthesis only; remote TTS is not enabled." },
  ];
}

export type BrowserSession = { token: string; expiresAt: number };

let browserSession: BrowserSession | undefined;
let pendingSession: Promise<BrowserSession> | undefined;

export async function getBrowserSessionToken(): Promise<string> {
  if (browserSession && browserSession.expiresAt > Date.now() + 30_000) {
    return browserSession.token;
  }
  if (!pendingSession) {
    pendingSession = (async () => {
      const response = await fetch(`${window.location.origin}/api/v1/session/token`, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) throw new Error("The local browser session could not be started.");
      const envelope: unknown = await response.json();
      if (!envelope || typeof envelope !== "object" || !("data" in envelope)) {
        throw new Error("The local browser session response was invalid.");
      }
      const data = envelope.data;
      if (
        !data || typeof data !== "object" || !("token" in data) || typeof data.token !== "string"
        || !("expiresAt" in data) || typeof data.expiresAt !== "string"
      ) {
        throw new Error("The local browser session response was invalid.");
      }
      const expiresAt = Date.parse(data.expiresAt);
      if (!Number.isFinite(expiresAt)) throw new Error("The local browser session response was invalid.");
      browserSession = { token: data.token, expiresAt };
      return browserSession;
    })().finally(() => { pendingSession = undefined; });
  }
  return (await pendingSession).token;
}

export function clearBrowserSession(): void {
  browserSession = undefined;
  pendingSession = undefined;
}

export type PwaStatus = {
  installed: boolean;
  installAvailable: boolean;
  updateAvailable: boolean;
};

export type PwaInstallAvailability = "installed" | "available" | "unavailable_or_not_offered";

export function pwaInstallAvailability(): PwaInstallAvailability {
  if (typeof window === "undefined") return "unavailable_or_not_offered";
  if (window.matchMedia?.("(display-mode: standalone)").matches) return "installed";
  return window.__jarvisInstallPrompt ? "available" : "unavailable_or_not_offered";
}

export const PWA_INSTALL_UNDETERMINED_MESSAGE = "PWA installation unavailable or not offered by this browser configuration.";

export async function requestPwaInstall(): Promise<boolean> {
  const prompt = window.__jarvisInstallPrompt;
  if (!prompt) return false;
  delete window.__jarvisInstallPrompt;
  window.dispatchEvent(new Event("jarvis-pwa-install-unavailable"));
  await prompt.prompt();
  return (await prompt.userChoice).outcome === "accepted";
}

export async function registerPwa(onUpdate: () => void): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !isBrowserDeployment()) return null;
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  if (registration.waiting) {
    window.__jarvisWaitingWorker = registration.waiting;
    onUpdate();
  }
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        window.__jarvisWaitingWorker = registration.waiting ?? worker;
        onUpdate();
      }
    });
  });
  void registration.update().catch(() => undefined);
  return registration;
}

export function activatePwaUpdate(): void {
  const worker = window.__jarvisWaitingWorker;
  if (!worker) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
  worker.postMessage({ type: "SKIP_WAITING" });
}