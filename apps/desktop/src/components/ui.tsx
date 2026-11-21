import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "solid" | "quiet" | "danger" | "outline";
  size?: "normal" | "small" | "icon";
};

export function Button({ className = "", variant = "quiet", size = "normal", ...props }: ButtonProps) {
  return <button className={`button button-${variant} button-${size} ${className}`} {...props} />;
}

export function Panel({ className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`panel ${className}`} {...props} />;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return <header className="page-heading">
    <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>
    {action && <div className="page-action">{action}</div>}
  </header>;
}

export function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{body}</p></div>;
}

export function Stat({ label, value, detail, tone = "cyan" }: { label: string; value: ReactNode; detail: string; tone?: string }) {
  return <div className={`stat stat-${tone}`}><span className="stat-label">{label}</span><strong>{value}</strong><span className="stat-detail">{detail}</span></div>;
}

export function StatusDot({ state = "offline" }: { state?: string }) {
  return <span className={`status-dot state-${state.replaceAll("_", "-")}`} aria-label={state} />;
}