import { useMemo, useState } from "react";
import { Download, Search, ShieldCheck } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { Badge, Button, EmptyState, PageHeading, Panel } from "@/components/ui";
import type { AuditRecord } from "@/types/contracts";

function csvValue(value: unknown): string {
  let text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv(records: AuditRecord[]) {
  const columns: Array<keyof AuditRecord> = ["occurred_at", "request_id", "tool_call_id", "tool_id", "action", "outcome", "decision", "confirmation_id", "permission_scopes", "affected_resources", "masked_arguments", "result_summary", "error_code", "duration_ms"];
  const content = [columns.map(csvValue).join(","), ...records.map((record) => columns.map((key) => csvValue(record[key])).join(","))].join("\r\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `jarvis-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AuditPage() {
  const [filter, setFilter] = useState("");
  const audit = useQuery({ queryKey: ["audit", 500, 0], queryFn: ({ signal }) => api.audit(500, 0, signal) });
  const records = useMemo(() => (audit.data ?? []).filter((record) => `${record.tool_id} ${record.action} ${record.outcome} ${record.decision ?? ""} ${record.error_code ?? ""}`.toLowerCase().includes(filter.toLowerCase())), [audit.data, filter]);
  return <div className="page-content">
    <PageHeading eyebrow="GOVERNANCE / TRACEABILITY" title="Audit log" description="Read-only records from backend tool execution, decisions, and permission checks." action={<Button variant="outline" disabled={!records.length} onClick={() => exportCsv(records)}><Download size={15} /> Export CSV</Button>} />
    <div className="audit-summary"><span><ShieldCheck size={17} /> Backend records</span><strong>{audit.data?.length ?? "—"}</strong><small>Latest 500 entries</small><div className="audit-search"><Search size={15} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter tool, action, outcome" aria-label="Filter audit records" /></div></div>
    <Panel className="audit-table-panel">{audit.isLoading ? <div className="loading-row">Loading audit records…</div> : audit.isError ? <p className="inline-error">{audit.error.message}</p> : records.length ? <div className="audit-list"><div className="audit-table-head"><span>TIME / REQUEST</span><span>TOOL / ACTION</span><span>OUTCOME</span><span>DECISION</span><span>RESULT</span></div>{records.map((record) => <AuditRow key={record.id} record={record} />)}</div> : <EmptyState icon={<ShieldCheck size={20} />} title="No audit records found" body={filter ? "Adjust your filter and try again." : "Backend tool and permission actions will be recorded here."} />}</Panel>
    <p className="audit-safety-note">Arguments shown in audit data are already masked by the backend. CSV export contains only the returned records.</p>
  </div>;
}

function AuditRow({ record }: { record: AuditRecord }) {
  return <details className="audit-row"><summary><span className="audit-time"><strong>{new Date(record.occurred_at).toLocaleString()}</strong><small>{record.request_id.slice(0, 8)}</small></span><span className="audit-action"><strong>{record.tool_id}</strong><small>{record.action}</small></span><span><Badge tone={record.outcome === "succeeded" || record.outcome === "authorized" ? "green" : record.outcome === "denied" ? "danger" : "neutral"}>{record.outcome}</Badge></span><span>{record.decision ? <Badge tone={record.decision === "approved" ? "green" : "amber"}>{record.decision}</Badge> : "—"}</span><span className="audit-result">{record.result_summary ?? record.error_code ?? "—"}</span></summary><div className="audit-details"><div><span>AFFECTED RESOURCES</span><p>{record.affected_resources.join(", ") || "None recorded"}</p></div><div><span>PERMISSION SCOPES</span><p>{record.permission_scopes.join(", ") || "None recorded"}</p></div><div><span>MASKED ARGUMENTS</span><pre>{JSON.stringify(record.masked_arguments, null, 2)}</pre></div><div><span>CONFIRMATION</span><p>{record.confirmation_id ?? "None"}</p></div></div></details>;
}