import { useMemo } from "react";
import { ArrowRight, AudioLines, Check, Circle, Database, KeyRound, PlugZap, ShieldCheck, Wrench } from "lucide-react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useBackendHealth, useLlmHealth } from "@/hooks/useBackend";
import { useTools } from "@/hooks/useTools";
import { usePreferences } from "@/hooks/usePreferences";
import { useSubmitCommand } from "@/hooks/useAssistant";
import { api } from "@/services/api";
import { browserFeatures, deploymentMode, isBrowserDeployment } from "@/services/deployment";
import { useAppStore } from "@/state/app-store";
import { Badge, Button, PageHeading, Panel } from "@/components/ui";

const steps = [
  { title: "Local API", description: "Connect to the configured localhost API and database readiness endpoint.", icon: PlugZap },
  { title: "Language model", description: "Check configured provider status. Credentials remain outside the renderer.", icon: KeyRound },
  { title: "Tool registry", description: "Review backend-registered tools, risk, and required scopes.", icon: Wrench },
  { title: "Permission model", description: "Review confirmation and grant behavior before authorizing a tool.", icon: ShieldCheck },
  { title: "Voice setup", description: "Review local speech-provider health and microphone consent.", icon: AudioLines },
];

export function OnboardingPage() {
  const browser = isBrowserDeployment();
  const features = browserFeatures();
  const submit = useSubmitCommand();
  const eventConnection = useAppStore((state) => state.eventConnection);
  const health = useBackendHealth();
  const llm = useLlmHealth();
  const tools = useTools();
  const voice = useQuery({ queryKey: ["voice", "health"], queryFn: ({ signal }) => api.voiceHealth(signal) });
  const { preferences, updatePreferences } = usePreferences();
  const state = useMemo(() => [
    health.data ? "ready" : health.isError ? "blocked" : "checking",
    llm.data?.status === "healthy" ? "ready" : llm.data?.status === "unconfigured" ? "optional" : llm.isError ? "blocked" : "checking",
    tools.data ? "ready" : tools.isError ? "blocked" : "checking",
    "ready",
    voice.data?.stt.status === "healthy" || voice.data?.wakeWord.status === "healthy" ? "ready" : voice.data?.stt.status === "unconfigured" && voice.data?.wakeWord.status === "unconfigured" ? "optional" : voice.isError ? "blocked" : "checking",
  ], [health.data, health.isError, llm.data?.status, llm.isError, tools.data, tools.isError, voice.data, voice.isError]);
  const complete = preferences.onboardingComplete;

  return <div className="page-content onboarding-page">
    <PageHeading eyebrow={browser ? "FIRST RUN / BROWSER PROFILE" : "FIRST RUN / LOCAL SETUP"} title={browser ? "Browser setup" : "Welcome to Jarvis"} description={browser ? "No administrator access or Electron runtime is required. Browser permissions and organization policy remain in control." : "Connect only the capabilities the local backend currently supports. Setup progress stays in desktop preferences."} />
    {browser && <Panel className="onboarding-audio-note"><ShieldCheck size={18} /><div><strong>{deploymentMode() === "pwa" ? "PWA installation is optional" : "Browser Mode is ready without installation"}</strong><span>Keep this page open for voice and live interactions. Microphone access is requested only after you choose Detect in Settings. Browser speech recognition is not enabled; configure backend STT for transcription.</span><small>Backend: {health.data?.status ?? (health.isError ? "offline" : "checking")} · WebSocket: {eventConnection}</small></div><Badge tone="neutral">No admin access</Badge><div className="onboarding-actions"><Button variant="outline" disabled={!features.speechSynthesis} onClick={() => window.speechSynthesis.speak(new SpeechSynthesisUtterance("Browser speech output is available."))}>Test browser speech</Button><Button variant="solid" disabled={submit.isPending} onClick={() => submit.mutate({ transcript: "Show the current time in UTC" })}>Test current-time command</Button></div></Panel>}
    <Panel className="onboarding-hero"><div className="onboarding-emblem"><Database size={22} /></div><div><p className="eyebrow">LOCAL-FIRST ASSISTANT</p><h2>{complete ? "Setup review complete" : "Review your local environment"}</h2><p>Health, provider status, and registered tools are checked against live backend responses. Unsupported features are clearly identified.</p></div><Badge tone={complete ? "green" : "cyan"}>{complete ? "Reviewed" : "5 checkpoints"}</Badge></Panel>
    <div className="onboarding-steps">{steps.map((step, index) => { const Icon = step.icon; const status = state[index]; return <article className="onboarding-step" key={step.title}><div className={`step-indicator step-${status}`}>{status === "ready" ? <Check size={16} /> : <Icon size={16} />}</div><div className="step-copy"><div><strong>{step.title}</strong><Badge tone={status === "ready" ? "green" : status === "unavailable" || status === "optional" ? "amber" : status === "blocked" ? "danger" : "neutral"}>{status}</Badge></div><p>{step.description}</p>{index === 0 && health.data && <small>{health.data.checks.map((check) => `${check.name}: ${check.status}`).join(" · ")}</small>}{index === 1 && llm.data && <small>{llm.data.status}: {llm.data.message}</small>}{index === 2 && tools.data && <small>{tools.data.length} registered · {tools.data.filter((tool) => tool.enabled).length} enabled</small>}</div><Link to={["/system", "/settings", "/tools", "/tools", "/settings"][index]} aria-label={`Review ${step.title}`}><ArrowRight size={15} /></Link></article>; })}</div>
    <Panel className="onboarding-audio-note"><AudioLines size={18} /><div><strong>Voice is opt-in</strong><span>Microphone access is off until you enable it. Voice activity and wake detection are reported only when real local providers are available.</span>{voice.data && <small>STT: {voice.data.stt.status} · Wake word: {voice.data.wakeWord.status}</small>}</div><Badge tone="neutral">Local</Badge></Panel>
    <div className="onboarding-footer"><span><Circle size={13} /> {complete ? "Local setup review saved" : "Progress is stored on this device only"}</span><Button variant="solid" onClick={() => void updatePreferences({ onboardingComplete: true, onboardingStep: 5 })}>{complete ? "Mark reviewed again" : "Mark setup reviewed"}<Check size={15} /></Button></div>
  </div>;
}