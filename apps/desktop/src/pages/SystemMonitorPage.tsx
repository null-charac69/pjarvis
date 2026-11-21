import { useState } from "react";
import { Activity, Database, HeartPulse, Radio, RefreshCw, ServerCog, WifiOff } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useBackendHealth, useLlmHealth } from "@/hooks/useBackend";
import { useAppStore } from "@/state/app-store";
import { Badge, Button, EmptyState, PageHeading, Panel, Stat } from "@/components/ui";
import { ToolTestDialog } from "@/components/ToolTestDialog";
import { useTools } from "@/hooks/useTools";
import type { ToolListing } from "@/types/contracts";

export function SystemMonitorPage() {
  const [selected, setSelected] = useState<ToolListing | null>(null);
  const health = useBackendHealth();
  const llm = useLlmHealth();
  const tools = useTools();
  const metricsTool = tools.data?.find((tool) => tool.manifest.tool_id === "system.metrics") ?? null;
  const events = useAppStore((state) => state.events);
  const metrics = events.filter((event) => event.type === "system.metric.updated").slice(-40).map((event) => ({ time: new Date(event.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }), metric: event.payload.metric, value: event.payload.value, unit: event.payload.unit }));
  const series = [...new Set(metrics.map((item) => item.metric))].slice(0, 4);
  const chartData = metrics.reduce<Array<Record<string, string | number>>>((rows, item) => {
    const row = rows.find((candidate) => candidate.time === item.time) ?? { time: item.time };
    row[item.metric] = item.value;
    if (!rows.includes(row)) rows.push(row);
    return rows;
  }, []);

  return <div className="page-content">
    <PageHeading eyebrow="OBSERVABILITY / HEALTH" title="System monitor" description="Backend readiness and real host samples emitted through the validated metric event stream." action={<><Button onClick={() => { void health.refetch(); void llm.refetch(); }}><RefreshCw size={15} /> Refresh checks</Button><Button variant="solid" disabled={!metricsTool?.enabled} onClick={() => setSelected(metricsTool)}><Activity size={15} /> Sample host</Button></>} />
    <div className="stat-grid three"><Stat label="API SERVICE" value={health.data?.status ?? (health.isError ? "Unavailable" : "Checking")} detail={health.data?.version ? `Version ${health.data.version}` : "Readiness endpoint"} tone={health.isError ? "red" : "green"} /><Stat label="DATABASE" value={health.data?.checks.find((check) => check.name === "database")?.status ?? (health.data ? "Healthy" : "Unknown")} detail="Backend readiness probe" tone={health.isError ? "red" : "cyan"} /><Stat label="LLM PROVIDER" value={llm.data?.status ?? (llm.isError ? "Unavailable" : "Checking")} detail={llm.data?.message ?? "Health endpoint"} tone={llm.isError ? "amber" : "blue"} /></div>
    <div className="monitor-grid"><Panel className="health-checks"><div className="panel-heading"><div><p className="eyebrow">SERVICE CHECKS</p><h2>Backend readiness</h2></div><HeartPulse size={18} /></div>{health.data?.checks.map((check) => <div className="health-check-row" key={check.name}><span className="health-check-icon">{check.name === "database" ? <Database size={16} /> : <ServerCog size={16} />}</span><strong>{check.name}</strong><Badge tone={check.status === "healthy" ? "green" : "danger"}>{check.status}</Badge></div>) ?? <EmptyState icon={<WifiOff size={19} />} title={health.isLoading ? "Checking service" : "No readiness data"} body={health.error?.message ?? "Start the local backend to inspect its health."} />}</Panel>
      <Panel className="metrics-panel"><div className="panel-heading"><div><p className="eyebrow">EVENT-DRIVEN METRICS</p><h2>Runtime telemetry</h2></div><Badge tone="blue"><Radio size={12} /> WebSocket</Badge></div>{chartData.length ? <><div className="chart-frame"><ResponsiveContainer width="100%" height="100%"><LineChart data={chartData} margin={{ top: 8, right: 10, bottom: 0, left: -16 }}><CartesianGrid stroke="rgba(166,195,215,.1)" vertical={false} /><XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fill: "#8194a2", fontSize: 10 }} /><YAxis tickLine={false} axisLine={false} tick={{ fill: "#8194a2", fontSize: 10 }} /><Tooltip contentStyle={{ background: "#101e2b", border: "1px solid #294050", borderRadius: 5, color: "#e8f2f7" }} /><Line type="monotone" dataKey={series[0]} stroke="#51d9e8" strokeWidth={2} dot={false} isAnimationActive={false} />{series.slice(1).map((key, index) => <Line key={key} type="monotone" dataKey={key} stroke={["#6aa8ff", "#e2ad62", "#86d596"][index]} strokeWidth={1.5} dot={false} isAnimationActive={false} />)}</LineChart></ResponsiveContainer></div><div className="metric-legend">{series.map((name) => <span key={name}><i />{name}</span>)}</div></> : <EmptyState icon={<Activity size={20} />} title="Waiting for metric events" body="Charts use only system.metric.updated values received from the backend. No synthetic machine data is generated." />}</Panel></div>
    <div className="capability-notice"><Activity size={17} /><div><strong>CPU, memory, and disk are sampled on request</strong><span>Samples come from the backend host through system.metrics. Network and process-level telemetry are not collected.</span></div><Badge tone={metricsTool?.enabled ? "green" : "neutral"}>{metricsTool?.enabled ? "Available" : "Unavailable"}</Badge></div>
    <ToolTestDialog tool={selected} onClose={() => setSelected(null)} />
  </div>;
}