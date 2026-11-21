import { AlertTriangle, Bell, CheckCheck, Info, ShieldAlert, Trash2, X } from "lucide-react";
import { useAppStore } from "@/state/app-store";
import { Badge, Button, EmptyState, PageHeading, Panel } from "@/components/ui";

const icons = { info: Info, warning: AlertTriangle, error: X, security: ShieldAlert };

export function NotificationsPage() {
  const notifications = useAppStore((state) => state.notifications);
  const markRead = useAppStore((state) => state.markNotificationRead);
  const markAllRead = useAppStore((state) => state.markAllNotificationsRead);
  const clear = useAppStore((state) => state.clearNotifications);
  const unread = notifications.filter((item) => !item.read).length;
  return <div className="page-content">
    <PageHeading eyebrow="SESSION / EVENTS" title="Notifications" description="Backend-published permission and status events received during this session." action={<><Button onClick={markAllRead} disabled={!unread}><CheckCheck size={15} /> Mark all read</Button><Button variant="danger" onClick={clear} disabled={!notifications.length}><Trash2 size={15} /> Clear session</Button></>} />
    <div className="notification-summary"><span>{notifications.length} received</span><Badge tone={unread ? "amber" : "green"}>{unread} unread</Badge><span className="notification-retention">Session only · not persisted</span></div>
    <Panel className="notification-list">{notifications.length ? notifications.map((notice) => { const Icon = icons[notice.severity]; return <article className={`notification-row ${notice.read ? "read" : ""}`} key={notice.id}><span className={`notification-icon severity-${notice.severity}`}><Icon size={17} /></span><div className="notification-copy"><div><strong>{notice.title}</strong>{!notice.read && <i />}</div><span>{new Date(notice.occurredAt).toLocaleString()} · Backend event</span>{notice.relatedId && <code>Correlation {notice.relatedId.slice(0, 8)}</code>}</div><Badge tone={notice.severity === "security" ? "danger" : notice.severity === "warning" ? "amber" : "neutral"}>{notice.severity}</Badge><Button size="icon" aria-label="Mark notification read" onClick={() => markRead(notice.id)} disabled={notice.read}><CheckCheck size={15} /></Button></article>; }) : <EmptyState icon={<Bell size={21} />} title="No notifications" body="Notifications appear here only when an actual backend event is received." />}</Panel>
  </div>;
}