import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Activity, ChevronRight, CirclePause, CirclePlay, KeyRound, RefreshCw, ShieldCheck, Wrench } from "lucide-react";
import { api } from "@/services/api";
import { useTools, useToggleTool, toolKeys } from "@/hooks/useTools";
import { Badge, Button, EmptyState, PageHeading, Panel, StatusDot } from "@/components/ui";
import { ToolTestDialog } from "@/components/ToolTestDialog";
import type { ToolListing } from "@/types/contracts";

export function ToolsPage() {
  const [selected, setSelected] = useState<ToolListing | null>(null);
  const tools = useTools();
  const toggle = useToggleTool();
  const client = useQueryClient();
  const healthQueries = useQueries({ queries: (tools.data ?? []).map((tool) => ({
    queryKey: toolKeys.health(tool.manifest.tool_id),
    queryFn: () => api.toolHealth(tool.manifest.tool_id),
    staleTime: 15_000,
  })) });
  const grants = useQuery({ queryKey: ["permissions", "grants"], queryFn: ({ signal }) => api.listGrants(signal) });

  return <div className="page-content">
    <PageHeading eyebrow="CAPABILITIES / POLICY" title="Tools & skills" description="Backend-registered capabilities, their health, risk, and permission requirements." action={<Button onClick={() => { void tools.refetch(); void client.invalidateQueries({ queryKey: ["permissions", "grants"] }); }}><RefreshCw size={15} /> Refresh</Button>} />
    <div className="tool-summary-row"><div><strong>{tools.data?.length ?? "—"}</strong><span>Registered tools</span></div><div><strong>{tools.data?.filter((tool) => tool.enabled).length ?? "—"}</strong><span>Enabled in backend</span></div><div><strong>{grants.data?.length ?? "—"}</strong><span>Active grants</span></div><div className="tool-summary-policy"><ShieldCheck size={18} /><span>Permission checks remain enforced by the backend.</span></div></div>
    <div className="tool-section-heading"><div><p className="eyebrow">TOOL REGISTRY</p><h2>Available capabilities</h2></div><span>Changes apply to the running backend session.</span></div>
    <Panel className="tools-table">{tools.isLoading ? <div className="loading-row">Loading registered tools…</div> : tools.isError ? <p className="inline-error">{tools.error.message}</p> : tools.data?.length ? tools.data.map((tool, index) => {
      const health = healthQueries[index];
      const manifest = tool.manifest;
      return <article className="tool-row" key={manifest.tool_id}><div className="tool-icon"><Wrench size={17} /></div><div className="tool-main"><div className="tool-title-line"><strong>{manifest.display_name}</strong><span className="tool-id">{manifest.tool_id}</span></div><p>{manifest.description}</p><div className="tool-tags"><Badge tone="blue">{manifest.category.replaceAll("_", " ")}</Badge><Badge tone={manifest.risk_level === "HIGH" || manifest.risk_level === "BLOCKED" ? "danger" : "neutral"}>{manifest.risk_level}</Badge>{manifest.required_scopes.map((scope) => <code key={scope}>{scope}</code>)}</div></div><div className="tool-health"><StatusDot state={health.data?.status ?? (health.isError ? "unavailable" : "checking")} /><span>{health.data?.status ?? (health.isError ? "unavailable" : "checking")}</span></div><label className="switch-control" title={tool.enabled ? "Disable tool" : "Enable tool"}><input type="checkbox" checked={tool.enabled} disabled={toggle.isPending} onChange={(event) => toggle.mutate({ toolId: manifest.tool_id, enabled: event.target.checked })} /><span /></label><Button size="small" variant="outline" disabled={!tool.enabled} onClick={() => setSelected(tool)}><Activity size={14} /> Test</Button></article>;
    }) : <EmptyState icon={<Wrench size={20} />} title="No registered tools" body="The backend currently has no tools available." />}</Panel>
    {toggle.isError && <p className="inline-error">{toggle.error.message}</p>}
    <div className="tool-section-heading grants-heading"><div><p className="eyebrow">PERMISSION SERVICE</p><h2>Active grants</h2></div><span>Session-approved access recorded by the API.</span></div>
    <Panel className="grant-list">{grants.isLoading ? <div className="loading-row">Loading grants…</div> : grants.isError ? <p className="inline-error">{grants.error.message}</p> : grants.data?.length ? grants.data.map((grant) => <GrantRow key={grant.id} grant={grant} />) : <EmptyState icon={<KeyRound size={19} />} title="No active grants" body="Session approval will create a grant here. Approve once is available for one-time actions." />}</Panel>
    <ToolTestDialog tool={selected} onClose={() => setSelected(null)} />
  </div>;
}

function GrantRow({ grant }: { grant: { id: string; tool_id: string; scope: string; resource_pattern: string; created_at: string } }) {
  const client = useQueryClient();
  const revoke = useMutation({ mutationFn: api.revokeGrant });
  return <div className="grant-row"><span className="grant-mark"><KeyRound size={15} /></span><div><strong>{grant.tool_id}</strong><span>{grant.scope} · {grant.resource_pattern}</span></div><time>{new Date(grant.created_at).toLocaleDateString()}</time><Button size="small" variant="danger" disabled={revoke.isPending} onClick={() => revoke.mutate(grant.id, { onSuccess: () => void client.invalidateQueries({ queryKey: ["permissions", "grants"] }) })}>Revoke</Button></div>;
}