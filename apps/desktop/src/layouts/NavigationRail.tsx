import {
  Activity, Archive, Bell, Bot, Command, FileStack, Gauge, History, KeyRound,
  LayoutDashboard, ListTodo, Settings2, ShieldCheck, Wrench,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { useAppStore } from "@/state/app-store";
import { isBrowserDeployment } from "@/services/deployment";

const primary = [
  { to: "/", label: "Command center", icon: LayoutDashboard },
  { to: "/conversation", label: "Conversations", icon: History },
  { to: "/tasks", label: "Tasks", icon: ListTodo },
  { to: "/tools", label: "Tools & skills", icon: Wrench },
];
const workspace = [
  { to: "/memory", label: "Memory", icon: Archive },
  { to: "/files", label: "Files & knowledge", icon: FileStack },
  { to: "/system", label: "System monitor", icon: Gauge },
];
const governance = [
  { to: "/audit", label: "Audit log", icon: ShieldCheck },
  { to: "/settings", label: "Settings", icon: Settings2 },
  { to: "/notifications", label: "Notifications", icon: Bell },
];

export function NavigationRail() {
  const unread = useAppStore((state) => state.notifications.filter((item) => !item.read).length);
  const workspaceItems = isBrowserDeployment()
    ? [...workspace, { to: "/capabilities", label: "Capabilities", icon: ShieldCheck }]
    : workspace;
  return <aside className="navigation-rail">
    <div className="brand-lockup"><div className="brand-mark"><Bot size={20} /></div><div className="brand-copy"><strong>JARVIS</strong><span>LOCAL ASSISTANT</span></div></div>
    <div className="nav-scroll">
      <nav aria-label="Primary navigation">
        <NavGroup label="Workspace" items={primary} />
        <NavGroup label="Resources" items={workspaceItems} />
        <NavGroup label="Control room" items={governance} unread={unread} />
      </nav>
    </div>
    <NavLink className="onboarding-link" to="/onboarding"><Activity size={17} /><span>Setup status</span><span className="nav-tail"><Command size={13} /></span></NavLink>
    <div className="rail-footer"><span className="operator-avatar">LO</span><div><strong>Local operator</strong><span>Personal workspace</span></div><KeyRound size={15} /></div>
  </aside>;
}

function NavGroup({ label, items, unread = 0 }: {
  label: string;
  items: Array<{ to: string; label: string; icon: typeof Activity }>;
  unread?: number;
}) {
  return <div className="nav-group"><p className="nav-group-label">{label}</p>{items.map(({ to, label: itemLabel, icon: Icon }) =>
    <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
      <Icon size={17} strokeWidth={1.8} /><span>{itemLabel}</span>
      {to === "/notifications" && unread > 0 && <span className="nav-count">{unread}</span>}
    </NavLink>,
  )}</div>;
}