import { AlertTriangle, Check, Info, ShieldAlert, X } from "lucide-react";
import { useAppStore } from "@/state/app-store";

const icons = { info: Info, warning: AlertTriangle, error: X, security: ShieldAlert };

export function NoticeStack() {
  const notificationLog = useAppStore((state) => state.notifications);
  const notices = notificationLog.filter((item) => !item.read).slice(0, 3);
  const markRead = useAppStore((state) => state.markNotificationRead);
  return <div className="notice-stack" aria-live="polite">{notices.map((notice) => {
    const Icon = icons[notice.severity];
    return <article className={`notice notice-${notice.severity}`} key={notice.id}><Icon size={16} /><div><strong>{notice.title}</strong><span>Backend event</span></div><button onClick={() => markRead(notice.id)} aria-label="Dismiss notification"><Check size={15} /></button></article>;
  })}</div>;
}