import { useEffect, useState } from "react";
import { Bell, ChevronDown, Command, Download, Minus, PanelRightClose, PanelRightOpen, RefreshCw, Search, Square, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppStore } from "@/state/app-store";
import { Button } from "@/components/ui";
import { activatePwaUpdate, deploymentMode, isBrowserDeployment, requestPwaInstall } from "@/services/deployment";

const titles: Record<string, string> = {
  "/": "Command center", "/conversation": "Conversations", "/tasks": "Task queue",
  "/tools": "Tools & skills", "/memory": "Memory", "/files": "Files & knowledge",
  "/system": "System monitor", "/capabilities": "Browser capabilities", "/audit": "Audit log", "/settings": "Settings",
  "/notifications": "Notifications", "/onboarding": "Setup",
};

export function TopBar({ onSearch, onToggleActivity, activityOpen }: {
  onSearch: () => void;
  onToggleActivity: () => void;
  activityOpen: boolean;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const connected = useAppStore((state) => state.backendConnected);
  const unread = useAppStore((state) => state.notifications.filter((item) => !item.read).length);
  const [maximized, setMaximized] = useState(false);
  const [installAvailable, setInstallAvailable] = useState(Boolean(window.__jarvisInstallPrompt));
  const [updateAvailable, setUpdateAvailable] = useState(Boolean(window.__jarvisWaitingWorker));
  const browserDeployment = isBrowserDeployment();

  useEffect(() => window.jarvis?.onMaximizedChange(setMaximized), []);
  useEffect(() => {
    const installAvailableEvent = () => setInstallAvailable(true);
    const installedEvent = () => setInstallAvailable(false);
    const installUnavailableEvent = () => setInstallAvailable(false);
    const updateEvent = () => setUpdateAvailable(true);
    window.addEventListener("jarvis-pwa-install-available", installAvailableEvent);
    window.addEventListener("jarvis-pwa-installed", installedEvent);
    window.addEventListener("jarvis-pwa-install-unavailable", installUnavailableEvent);
    window.addEventListener("jarvis-pwa-update", updateEvent);
    return () => {
      window.removeEventListener("jarvis-pwa-install-available", installAvailableEvent);
      window.removeEventListener("jarvis-pwa-installed", installedEvent);
      window.removeEventListener("jarvis-pwa-install-unavailable", installUnavailableEvent);
      window.removeEventListener("jarvis-pwa-update", updateEvent);
    };
  }, []);

  return <header className="topbar">
    <div className="titlebar-drag"><div className="breadcrumbs"><span>JARVIS</span><span className="crumb-slash">/</span><strong>{titles[location.pathname] ?? "Workspace"}</strong></div></div>
    <div className="topbar-actions">
      <span className={`connection-chip ${connected ? "online" : "offline"}`}><i />{connected ? "Backend online" : "Backend offline"}</span>
      {browserDeployment && <span className="deployment-chip">{deploymentMode() === "pwa" ? "PWA Mode" : "Browser Mode"}</span>}
      {browserDeployment && installAvailable && <Button size="small" variant="outline" onClick={() => void requestPwaInstall()}><Download size={14} /> Install app</Button>}
      {browserDeployment && updateAvailable && <Button size="small" variant="outline" onClick={activatePwaUpdate}><RefreshCw size={14} /> Update</Button>}
      <Button size="small" className="search-trigger" onClick={onSearch}><Search size={14} /><span>Search</span><kbd>Ctrl K</kbd></Button>
      <Button size="icon" aria-label="Notifications" title="Notifications" onClick={() => navigate("/notifications")} className="top-icon"><Bell size={17} />{unread > 0 && <i className="icon-count" />}</Button>
      <Button size="icon" aria-label={activityOpen ? "Hide activity panel" : "Show activity panel"} title="Toggle activity panel" onClick={onToggleActivity} className="top-icon"><span>{activityOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}</span></Button>
      {!browserDeployment && <span className="window-divider" />}
      {window.jarvis && <div className="window-controls"><Button size="icon" aria-label="Minimize" onClick={() => window.jarvis?.minimizeWindow()}><Minus size={15} /></Button><Button size="icon" aria-label={maximized ? "Restore" : "Maximize"} onClick={() => window.jarvis?.toggleMaximizeWindow()}>{maximized ? <ChevronDown size={14} /> : <Square size={12} />}</Button><Button size="icon" aria-label="Close" onClick={() => window.jarvis?.closeWindow()}><X size={15} /></Button></div>}
    </div>
  </header>;
}