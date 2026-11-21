import { ArrowUpRight, Circle, LoaderCircle, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { useAppStore } from "@/state/app-store";
import { Badge, Button, StatusDot } from "@/components/ui";

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(value).toLocaleDateString();
}

export function ActivityPanel({ onClose }: { onClose: () => void }) {
  const state = useAppStore((store) => store.assistantState);
  const eventLog = useAppStore((store) => store.events);
  const eventConnection = useAppStore((store) => store.eventConnection);
  const events = eventLog.slice(-12).reverse();
  const activeTaskId = useAppStore((store) => store.activeTaskId);
  const label = state.replaceAll("_", " ");
  return <aside className="activity-panel">
    <div className="activity-head"><div><p className="eyebrow">Live session</p><h2>Activity</h2></div><Button size="icon" onClick={onClose} aria-label="Close activity panel">×</Button></div>
    <div className="assistant-status-card"><div className="activity-orbit"><div className={`orbit-core ${state}`}><Circle size={21} /></div></div><div><div className="status-line"><StatusDot state={state} /><strong>{label}</strong></div><span>Assistant runtime</span></div></div>
    {activeTaskId && <div className="active-task-callout"><LoaderCircle className="spin" size={15} /><div><strong>Task in progress</strong><span>{activeTaskId.slice(0, 8)}</span></div><Link to="/tasks" onClick={onClose} aria-label="Open tasks"><ArrowUpRight size={14} /></Link></div>}
    <div className="activity-section-title"><span>EVENT STREAM</span><span className={`event-connection event-connection-${eventConnection}`} role="status" aria-live="polite"><StatusDot state={eventConnection} />{eventConnection}</span><Badge tone="neutral">{events.length}</Badge></div>
    <div className="activity-feed" aria-live="polite">{events.length ? events.map((event) => <div className="activity-event" key={event.eventId}><span className={`event-mark event-${event.type.split(".")[0]}`} /><div><strong>{event.type.replaceAll(".", " ")}</strong><span>{relativeTime(event.occurredAt)}</span></div></div>) : <div className="activity-empty"><ShieldCheck size={18} /><span>Events from the backend will appear here.</span></div>}</div>
    <Link to="/audit" className="activity-audit-link" onClick={onClose}>Review audit log <ArrowUpRight size={14} /></Link>
  </aside>;
}