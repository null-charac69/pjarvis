import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Outlet } from "react-router-dom";
import { NavigationRail } from "@/layouts/NavigationRail";
import { TopBar } from "@/layouts/TopBar";
import { ActivityPanel } from "@/layouts/ActivityPanel";
import { CommandPalette } from "@/components/CommandPalette";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { NoticeStack } from "@/components/NoticeStack";
import { useEventStream } from "@/hooks/useEventStream";
import { useBackendHealth } from "@/hooks/useBackend";
import { useActiveTask } from "@/hooks/useTasks";
import { usePreferences } from "@/hooks/usePreferences";
import { useAppStore } from "@/state/app-store";
import { assistantConfirmation } from "@/hooks/useConfirmations";
import { isBrowserDeployment } from "@/services/deployment";
import { isEditableTarget, loadBrowserShortcutPreferences, matchesBrowserVoiceShortcut } from "@/services/browser-voice";
import { browserNotificationDeliveryAllowed, safeBrowserNotification } from "@/services/browser-notifications";

export function AppShell() {
  const [activityOpen, setActivityOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { preferences, updatePreferences, loaded } = usePreferences();
  const health = useBackendHealth();
  useEventStream();
  const task = useActiveTask();
  const setBackendConnected = useAppStore((state) => state.setBackendConnected);
  const setPendingConfirmation = useAppStore((state) => state.setPendingConfirmation);
  const events = useAppStore((state) => state.events);
  const browser = isBrowserDeployment();
  const seenNotificationEvents = useRef(new Set<string>());
  const notificationEventsInitialized = useRef(false);

  useEffect(() => setBackendConnected(Boolean(health.data)), [health.data, setBackendConnected]);
  useEffect(() => window.jarvis?.onVoiceShortcut(() => {
    useAppStore.getState().requestVoiceShortcut();
    navigate("/");
  }), [navigate]);
  useEffect(() => {
    if (!browser) return;
    if (!notificationEventsInitialized.current) {
      events.forEach((event) => seenNotificationEvents.current.add(event.eventId));
      notificationEventsInitialized.current = true;
      return;
    }
    for (const event of events) {
      if (seenNotificationEvents.current.has(event.eventId)) continue;
      seenNotificationEvents.current.add(event.eventId);
      if (!("Notification" in window) || !browserNotificationDeliveryAllowed(preferences.browserNotificationsEnabled, Notification.permission, document.visibilityState)) continue;
      const notification = safeBrowserNotification(event);
      if (!notification) continue;
      try { new Notification(notification.title, { body: notification.body, tag: event.eventId }); } catch { /* In-app notifications remain available. */ }
    }
  }, [browser, events, preferences.browserNotificationsEnabled]);
  useEffect(() => {
    if (!task.data) return;
    const current = useAppStore.getState().pendingConfirmation;
    const pending = assistantConfirmation(task.data);
    if (pending) {
      if (current?.mode !== "assistant" || current.confirmationId !== pending.confirmationId) {
        setPendingConfirmation(pending);
      }
    } else if (current?.mode === "assistant" && current.taskId === task.data.taskId) {
      setPendingConfirmation(null);
    }
  }, [task.data, setPendingConfirmation]);
  useEffect(() => {
    if (!loaded) return;
    setActivityOpen(!preferences.activityCollapsed);
    const systemTheme = window.matchMedia("(prefers-color-scheme: light)");
    const applyTheme = () => {
      document.documentElement.dataset.theme = preferences.theme === "system"
        ? systemTheme.matches ? "light" : "dark"
        : preferences.theme;
    };
    applyTheme();
    document.documentElement.dataset.accent = preferences.accent;
    document.documentElement.dataset.density = preferences.density;
    document.documentElement.dataset.motion = preferences.reducedMotion ? "reduced" : "full";
    document.documentElement.style.setProperty("--font-scale", String(preferences.fontScale));
    if (preferences.theme === "system") systemTheme.addEventListener("change", applyTheme);
    return () => systemTheme.removeEventListener("change", applyTheme);
  }, [loaded, preferences]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!browser) return;
    let held = false;
    const voiceRouteActive = () => location.pathname === "/" || location.pathname === "/conversation";
    const dispatchVoice = (name: string) => window.dispatchEvent(new Event(`jarvis-browser-ptt-${name}`));
    const cancelHeldShortcut = () => {
      if (!held) return;
      held = false;
      dispatchVoice("cancel");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && held) {
        event.preventDefault();
        cancelHeldShortcut();
        return;
      }
      const config = loadBrowserShortcutPreferences();
      if (!voiceRouteActive() || !config.enabled || isEditableTarget(event.target) || event.repeat || held) return;
      if (!matchesBrowserVoiceShortcut(event, config.shortcut)) return;
      event.preventDefault();
      held = true;
      dispatchVoice("start");
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!held) return;
      if (!matchesBrowserVoiceShortcut(event, loadBrowserShortcutPreferences().shortcut)) return;
      event.preventDefault();
      held = false;
      dispatchVoice("stop");
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", cancelHeldShortcut);
    document.addEventListener("visibilitychange", cancelHeldShortcut);
    return () => {
      cancelHeldShortcut();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", cancelHeldShortcut);
      document.removeEventListener("visibilitychange", cancelHeldShortcut);
    };
  }, [browser, location.pathname]);

  return <div className={`app-frame ${activityOpen ? "activity-visible" : ""}`}>
    <NavigationRail />
    <div className="work-area"><TopBar onSearch={() => setSearchOpen(true)} onToggleActivity={() => {
      const next = !activityOpen;
      setActivityOpen(next);
      void updatePreferences({ activityCollapsed: !next });
    }} activityOpen={activityOpen} />
      <main className="page-viewport"><Outlet /></main>
    </div>
    {activityOpen && <ActivityPanel onClose={() => {
      setActivityOpen(false);
      void updatePreferences({ activityCollapsed: true });
    }} />}
    <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    <ConfirmationDialog />
    <NoticeStack />
  </div>;
}