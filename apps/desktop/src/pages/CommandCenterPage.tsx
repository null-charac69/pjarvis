import { ArrowRight, CheckCircle2, CloudOff, Command, LoaderCircle, Shield, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useSubmitCommand } from "@/hooks/useAssistant";
import { AssistantCore } from "@/components/AssistantCore";
import { CommandComposer } from "@/components/CommandComposer";
import { ExecutionTimeline } from "@/components/ExecutionTimeline";
import { Badge, Button, PageHeading, Panel, Stat } from "@/components/ui";
import { useBackendHealth, useLlmHealth } from "@/hooks/useBackend";
import { useAppStore } from "@/state/app-store";
import { useTools } from "@/hooks/useTools";

const prompts = [
  { text: "Check the local API and database health", icon: Shield },
  { text: "Show the current time in UTC", icon: Command },
  { text: "List my approved workspaces", icon: Wrench },
];

export function CommandCenterPage() {
  const health = useBackendHealth();
  const llm = useLlmHealth();
  const tools = useTools();
  const assistantState = useAppStore((state) => state.assistantState);
  const latestTask = useAppStore((state) => state.latestTask);
  const timeline = useAppStore((state) => state.timeline);
  const active = useAppStore((state) => state.activeTaskId);

  return <div className="page-content command-page">
    <PageHeading eyebrow="OPERATIONS / OVERVIEW" title="Command center" description="A clear view of your local assistant, approved tools, and current execution." action={<Link className="text-link" to="/audit">Open audit trail <ArrowRight size={14} /></Link>} />
    <div className="stat-grid four">
      <Stat label="BACKEND" value={health.data?.status ?? (health.isError ? "Offline" : "Checking")} detail={health.data?.version ? `API v${health.data.version}` : "Local service"} tone={health.isError ? "red" : "cyan"} />
      <Stat label="LANGUAGE MODEL" value={llm.data?.status ?? (llm.isError ? "Unavailable" : "Checking")} detail={llm.data?.message ?? "Provider health endpoint"} tone={llm.isError ? "amber" : "blue"} />
      <Stat label="APPROVED TOOLS" value={tools.data?.filter((tool) => tool.enabled).length ?? "—"} detail={tools.data ? `${tools.data.length} registered in backend` : "Waiting for backend"} tone="green" />
      <Stat label="ACTIVE TASK" value={active ? "Running" : "None"} detail={active ? active.slice(0, 8) : "No background task"} tone={active ? "amber" : "neutral"} />
    </div>
    <div className="command-layout">
      <div className="command-main-column">
        <Panel className="assistant-panel"><div className="panel-label-row"><span className="eyebrow">PERSONAL ASSISTANT</span><Badge tone={health.data ? "green" : "neutral"}>{health.data ? "LOCAL API READY" : "CHECKING BACKEND"}</Badge></div><AssistantCore state={assistantState} /><CommandComposer /></Panel>
        <Panel className="timeline-panel"><div className="panel-heading"><div><p className="eyebrow">SESSION TRACE</p><h2>Execution timeline</h2></div><Link to="/tasks" className="subtle-link">All tasks <ArrowRight size={14} /></Link></div><ExecutionTimeline items={timeline} task={latestTask} /></Panel>
      </div>
      <aside className="command-side-column">
        <Panel className="quick-panel"><div className="panel-heading compact"><div><p className="eyebrow">TRY A COMMAND</p><h2>Quick starts</h2></div></div><div className="quick-prompts">{prompts.map(({ text, icon: Icon }) => <QuickPrompt key={text} text={text} icon={<Icon size={15} />} />)}</div></Panel>
        <Panel className="trust-panel"><div className="trust-heading"><div className="trust-icon"><CheckCircle2 size={18} /></div><div><p className="eyebrow">SECURITY MODEL</p><h2>Permission first</h2></div></div><p>Every tool call is checked by the backend. Sensitive actions pause for your approval and are written to the audit log.</p><Link to="/tools" className="subtle-link">Review approved tools <ArrowRight size={14} /></Link></Panel>
        {health.isError && <Panel className="offline-panel"><CloudOff size={18} /><div><strong>Backend not responding</strong><span>Start the local API to enable commands and live data.</span></div><Button size="small" onClick={() => void health.refetch()}>Retry</Button></Panel>}
        {!llm.isError && llm.data?.status === "unconfigured" && <div className="provider-note"><LoaderCircle size={14} /><span>LLM provider is unconfigured; rule-based routes may still be available.</span></div>}
      </aside>
    </div>
  </div>;
}

function QuickPrompt({ text, icon }: { text: string; icon: ReactNode }) {
  const submit = useSubmitCommand();
  return <button className="quick-prompt" onClick={() => {
    submit.mutate({ transcript: text });
  }} disabled={submit.isPending}><span>{icon}</span><strong>{text}</strong><ArrowRight size={14} /></button>;
}