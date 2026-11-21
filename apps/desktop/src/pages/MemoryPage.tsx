import { BookOpen, BrainCircuit, Clock3, LockKeyhole, Plus } from "lucide-react";
import { EmptyState, PageHeading, Panel, Badge, Button } from "@/components/ui";

export function MemoryPage() {
  return <div className="page-content">
    <PageHeading eyebrow="PERSONALIZATION / MEMORY" title="Memory" description="Persistent preferences and facts are not exposed by the current backend." action={<Button disabled title="Memory persistence is not available"><Plus size={15} /> Add memory</Button>} />
    <Panel className="unavailable-banner"><div className="unavailable-symbol"><BrainCircuit size={21} /></div><div><p className="eyebrow">BACKEND CAPABILITY NOT AVAILABLE</p><h2>No memory service is connected</h2><p>This screen is intentionally read-only. The current API has no memory create, search, update, deletion, or retention endpoints.</p></div><Badge tone="amber">Unavailable</Badge></Panel>
    <div className="memory-explainer-grid"><Panel><span className="memory-icon"><BookOpen size={17} /></span><strong>Stored facts</strong><p>No persistent assistant facts are exposed by the backend.</p></Panel><Panel><span className="memory-icon"><Clock3 size={17} /></span><strong>Retention controls</strong><p>Retention and expiry policies cannot be configured from this client.</p></Panel><Panel><span className="memory-icon"><LockKeyhole size={17} /></span><strong>Local privacy</strong><p>Assistant conversation and task history is separate from memory and can be reviewed in Conversations.</p></Panel></div>
    <Panel className="memory-empty"><EmptyState icon={<BrainCircuit size={22} />} title="Nothing to display" body="No sample or placeholder memories are shown." /></Panel>
  </div>;
}