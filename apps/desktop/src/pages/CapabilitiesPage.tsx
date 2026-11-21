import { useQuery } from "@tanstack/react-query";
import { Activity, Mic, MonitorDown, ShieldAlert } from "lucide-react";
import { Badge, PageHeading, Panel, Stat } from "@/components/ui";
import { useBackendHealth, useLlmHealth } from "@/hooks/useBackend";
import { useTools } from "@/hooks/useTools";
import { api } from "@/services/api";
import { browserCapabilityMatrix, browserFeatures, deploymentMode, type CapabilityStatus } from "@/services/deployment";
import "@/styles/capabilities.css";

function providerStatus(status: string | undefined): CapabilityStatus {
  if (status === "healthy") return "available";
  if (status === "degraded") return "degraded";
  if (status === "unavailable") return "unavailable";
  return "unconfigured";
}

function configuredToolStatus(enabled: boolean | undefined): CapabilityStatus {
  return enabled ? "available" : "unconfigured";
}

const badgeTone: Record<CapabilityStatus, string> = {
  available: "green",
  unavailable: "danger",
  blocked_by_policy: "amber",
  unconfigured: "neutral",
  degraded: "amber",
  unsupported: "neutral",
};

export function CapabilitiesPage() {
  const health = useBackendHealth();
  const llm = useLlmHealth();
  const voice = useQuery({ queryKey: ["backend", "voice-health"], queryFn: () => api.voiceHealth(), refetchInterval: 30_000 });
  const tools = useTools();
  const features = browserFeatures();
  const listedTools = tools.data ?? [];
  const findTool = (part: string) => listedTools.find((tool) => tool.manifest.tool_id.includes(part));
  const sttStatus = providerStatus(voice.data?.stt.status);
  const microphoneStatus: CapabilityStatus = !features.secureContext || !features.microphone
    ? "unavailable"
    : sttStatus;
  const statuses: Record<string, CapabilityStatus> = {
    voice_input: microphoneStatus,
    push_to_talk: microphoneStatus,
    wake_word: features.microphone && features.secureContext
      ? providerStatus(voice.data?.wakeWord.status)
      : "unavailable",
    tts: features.speechSynthesis ? "available" : "unsupported",
    web_search: configuredToolStatus(findTool("search")?.enabled),
    weather: configuredToolStatus(findTool("weather")?.enabled),
    workspace_tools: configuredToolStatus(listedTools.some((tool) => tool.enabled && tool.manifest.category === "filesystem")),
    git_read: configuredToolStatus(listedTools.some((tool) => tool.enabled && tool.manifest.tags.some((tag) => tag.toLowerCase().includes("git")))),
    notifications: features.notifications ? "available" : "unsupported",
    stt_provider: sttStatus,
    tts_provider: features.speechSynthesis ? "available" : "unsupported",
  };
  const capabilities = browserCapabilityMatrix().map((capability) => ({
    ...capability,
    status: statuses[capability.id] ?? capability.status,
  }));

  return <div className="page-content">
    <PageHeading eyebrow="DEPLOYMENT / BROWSER PROFILE" title="Browser capabilities" description="Runtime support and operator-configured backend services for this browser session." />
    <div className="stat-grid three capability-runtime-stats">
      <Stat label="DEPLOYMENT" value={deploymentMode() === "pwa" ? "PWA" : "Browser"} detail={features.standalone ? "Installed standalone window" : "Browser tab"} tone="cyan" />
      <Stat label="LOCAL API" value={health.data?.status ?? (health.isError ? "Unavailable" : "Checking")} detail={health.data?.version ? `Version ${health.data.version}` : "Readiness endpoint"} tone={health.isError ? "red" : "green"} />
      <Stat label="LLM PROVIDER" value={llm.data?.status ?? (llm.isError ? "Unavailable" : "Checking")} detail={llm.data?.message ?? "Backend-selected provider"} tone={llm.isError ? "amber" : "blue"} />
    </div>
    <Panel className="capability-list-panel">
      <div className="panel-heading"><div><p className="eyebrow">CURRENT RUNTIME</p><h2>Feature availability</h2></div><Activity size={18} /></div>
      <div className="capability-list" role="list">
        {capabilities.map((capability) => <div className="capability-row" role="listitem" key={capability.id}>
          <div className="capability-copy"><strong>{capability.label}</strong><span>{capability.detail}</span></div>
          <Badge tone={badgeTone[capability.status]}>{capability.status.replaceAll("_", " ")}</Badge>
        </div>)}
      </div>
    </Panel>
    <div className="capability-notice"><Mic size={17} /><div><strong>Microphone permission is requested only when voice capture starts</strong><span>Voice features require a secure browser context and remain active only while the page is open.</span></div></div>
    <div className="capability-notice"><ShieldAlert size={17} /><div><strong>Backend permissions remain authoritative</strong><span>Browser visibility does not grant access. Tool permissions, confirmations, audit, and approved origins are enforced by the local API.</span></div></div>
    <div className="capability-notice"><MonitorDown size={17} /><div><strong>Unsupported desktop integration is not simulated</strong><span>No system tray, global shortcut, background worker, application launcher, or OS scheduler is installed in browser mode.</span></div></div>
  </div>;
}