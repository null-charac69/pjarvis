import { useState } from "react";
import { ArrowUpRight, FileSearch, FolderLock, HardDrive, LockKeyhole, Upload } from "lucide-react";
import { Link } from "react-router-dom";
import { useTools } from "@/hooks/useTools";
import { PageHeading, Panel, Badge, Button } from "@/components/ui";
import { ToolTestDialog } from "@/components/ToolTestDialog";
import type { ToolListing } from "@/types/contracts";

export function FilesPage() {
  const tools = useTools();
  const [selected, setSelected] = useState<ToolListing | null>(null);
  const workspaceTools = tools.data?.filter((tool) => [
    "workspace.list",
    "workspace.files",
    "workspace.read",
    "workspace.search",
    "workspace.write",
    "workspace.delete_file",
  ].includes(tool.manifest.tool_id)) ?? [];

  return <div className="page-content">
    <PageHeading eyebrow="LOCAL DATA / WORKSPACES" title="Files & knowledge" description="Inspect only workspaces approved by the backend operator." />
    <Panel className="file-policy-banner"><div className="file-policy-icon"><FolderLock size={21} /></div><div><strong>Approved roots only</strong><p>The app does not browse arbitrary machine paths. Workspace access is validated and permission-gated by the backend.</p></div><Badge tone="green">Policy enforced</Badge></Panel>
    <div className="file-capability-grid"><Panel className="file-capability"><div className="capability-icon"><HardDrive size={18} /></div><div><div className="capability-title"><h2>Workspace tools</h2><Badge tone={workspaceTools.length ? "green" : "neutral"}>{workspaceTools.length ? "Available" : "Not registered"}</Badge></div><p>Browse, search, read, create, replace, and delete text files only inside approved workspace roots. Mutations require confirmation.</p>{workspaceTools.length ? <div className="workspace-tool-list">{workspaceTools.map((tool) => <div key={tool.manifest.tool_id}><span><FileSearch size={15} />{tool.manifest.tool_id}</span><Button size="small" variant="outline" disabled={!tool.enabled} onClick={() => setSelected(tool)}>Open tool <ArrowUpRight size={13} /></Button></div>)}</div> : <Link className="text-link" to="/tools">Review registered tools <ArrowUpRight size={14} /></Link>}</div></Panel>
      <Panel className="file-capability unavailable-file"><div className="capability-icon"><Upload size={18} /></div><div><div className="capability-title"><h2>Ingestion & indexing</h2><Badge tone="amber">Unavailable</Badge></div><p>Upload, OCR, embeddings, vector search, and knowledge-base indexing have no backend endpoints in this phase.</p><Button disabled title="File ingestion has no backend endpoint"><Upload size={14} /> Ingestion not configured</Button></div></Panel></div>
    <div className="file-safety-note"><LockKeyhole size={15} /><span>Tool schemas and backend permissions determine all accessible paths. The renderer never receives filesystem APIs.</span></div>
    <ToolTestDialog tool={selected} onClose={() => setSelected(null)} />
  </div>;
}