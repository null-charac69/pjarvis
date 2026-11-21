import { useEffect, useRef, useState } from "react";
import { Activity, Archive, ArrowDown, ArrowUp, FileStack, Gauge, History, LayoutDashboard, ListTodo, Search, Settings2, ShieldCheck, Wrench, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

const commands = [
  { to: "/", title: "Command center", detail: "Send a local assistant command", icon: LayoutDashboard },
  { to: "/conversation", title: "Conversations", detail: "Review persisted assistant history", icon: History },
  { to: "/tasks", title: "Tasks", detail: "Inspect and cancel active tasks", icon: ListTodo },
  { to: "/tools", title: "Tools & skills", detail: "Review health, permissions, and test tools", icon: Wrench },
  { to: "/memory", title: "Memory", detail: "Memory backend unavailable", icon: Archive },
  { to: "/files", title: "Files & knowledge", detail: "Ingestion backend unavailable", icon: FileStack },
  { to: "/system", title: "System monitor", detail: "Live backend health", icon: Gauge },
  { to: "/audit", title: "Audit log", detail: "Review permission-gated actions", icon: ShieldCheck },
  { to: "/settings", title: "Settings", detail: "Desktop and provider status", icon: Settings2 },
  { to: "/notifications", title: "Notifications", detail: "Review current session alerts", icon: Activity },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const filtered = commands.filter((command) => `${command.title} ${command.detail}`.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  if (!open) return null;
  function go(to: string) { navigate(to); onClose(); }
  return <div className="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={(event) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowDown") { event.preventDefault(); setSelected((index) => Math.min(index + 1, filtered.length - 1)); }
      if (event.key === "ArrowUp") { event.preventDefault(); setSelected((index) => Math.max(index - 1, 0)); }
      if (event.key === "Enter" && filtered[selected]) go(filtered[selected].to);
    }}>
      <div className="palette-search"><Search size={18} /><input ref={input} value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} placeholder="Find a view or action..." aria-label="Search commands" /><kbd>ESC</kbd><button onClick={onClose} aria-label="Close search"><X size={16} /></button></div>
      <div className="palette-list" role="listbox">{filtered.map(({ to, title, detail, icon: Icon }, index) => <button key={to} role="option" aria-selected={index === selected} className={`palette-option ${index === selected ? "selected" : ""}`} onClick={() => go(to)} onMouseEnter={() => setSelected(index)}><span className="palette-option-icon"><Icon size={17} /></span><span><strong>{title}</strong><small>{detail}</small></span>{index === selected && <span className="palette-enter"><ArrowDown size={13} /> Enter</span>}</button>)}{filtered.length === 0 && <p className="palette-no-results">No matching views.</p>}</div>
      <footer className="palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open view</span></footer>
    </section>
  </div>;
}