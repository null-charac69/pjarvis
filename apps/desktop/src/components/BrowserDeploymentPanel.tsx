import { useEffect, useState } from "react";
import { FolderOpen, Mic, Volume2 } from "lucide-react";
import { Badge, Button, Panel } from "@/components/ui";
import { BROWSER_SHORTCUT_OPTIONS, directoryPickerOutcome, directoryPickerSupported, loadBrowserShortcutPreferences, saveBrowserShortcutPreferences, type BrowserShortcutPreferences } from "@/services/browser-voice";
import { isBrowserDeployment } from "@/services/deployment";
import { usePreferences } from "@/hooks/usePreferences";
import { useTools } from "@/hooks/useTools";

export function BrowserDeploymentPanel() {
  const browser = isBrowserDeployment();
  const { preferences, updatePreferences } = usePreferences();
  const tools = useTools();
  const [shortcut, setShortcut] = useState<BrowserShortcutPreferences>(loadBrowserShortcutPreferences);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [directoryName, setDirectoryName] = useState("");
  const [directoryStatus, setDirectoryStatus] = useState("not_selected");

  useEffect(() => {
    if (!browser || !("speechSynthesis" in window)) return;
    const refresh = () => setVoices(window.speechSynthesis.getVoices().filter((voice) => voice.localService));
    refresh();
    window.speechSynthesis.addEventListener("voiceschanged", refresh);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", refresh);
  }, [browser]);

  useEffect(() => {
    if (!browser) return;
    setNotificationPermission("Notification" in window ? Notification.permission : "unsupported");
  }, [browser]);

  if (!browser) return null;

  function updateShortcut(patch: Partial<BrowserShortcutPreferences>) {
    const next = { ...shortcut, ...patch };
    setShortcut(next);
    saveBrowserShortcutPreferences(next);
  }

  async function enableNotifications() {
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    await updatePreferences({ browserNotificationsEnabled: permission === "granted" });
  }

  async function selectDirectory() {
    const pickerWindow = window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> };
    const picker = pickerWindow.showDirectoryPicker;
    if (!directoryPickerSupported(picker) || typeof picker !== "function") {
      setDirectoryStatus("unsupported");
      return;
    }
    try {
      const handle = await picker.call(pickerWindow);
      setDirectoryName(handle.name);
      setDirectoryStatus("selected");
    } catch (error) {
      setDirectoryStatus(directoryPickerOutcome(error));
    }
  }

  function testLocalSpeech() {
    if (!("speechSynthesis" in window) || voices.length === 0) return;
    const utterance = new SpeechSynthesisUtterance("Browser-local speech output is available.");
    utterance.voice = voices.find((voice) => voice.voiceURI === preferences.voiceOutputVoiceURI) ?? voices[0];
    utterance.volume = preferences.voiceOutputVolume;
    utterance.rate = preferences.voiceOutputRate;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  const workspaceTools = tools.data?.filter((tool) => tool.enabled && tool.manifest.category === "filesystem") ?? [];

  return <Panel id="deployment-controls" className="settings-section deployment-settings">
    <div className="settings-section-title"><span><Mic size={17} /></span><div><h2>Browser Voice & Permissions</h2><p>Microphone and notification access are requested only after you activate their controls.</p></div></div>
    <div className="setting-row"><div><strong>In-page voice shortcut</strong><span>Press and hold while this page is focused. It is not a global OS shortcut.</span></div><label className="switch-control"><input type="checkbox" checked={shortcut.enabled} onChange={(event) => updateShortcut({ enabled: event.target.checked })} /><span /></label></div>
    <div className="setting-row"><div><strong>Shortcut</strong><span>Editable fields ignore this shortcut. Escape cancels an active recording.</span></div><select aria-label="In-page voice shortcut" value={shortcut.shortcut} disabled={!shortcut.enabled} onChange={(event) => updateShortcut({ shortcut: event.target.value as BrowserShortcutPreferences["shortcut"] })}>{BROWSER_SHORTCUT_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}</select></div>
    <div className="setting-row"><div><strong>Stop after silence</strong><span>Silence timeout for browser push-to-talk.</span></div><input aria-label="Stop after silence" type="number" min="500" max="5000" step="100" value={preferences.voiceSilenceMs} onChange={(event) => void updatePreferences({ voiceSilenceMs: Math.max(500, Math.min(5000, Number(event.target.value) || 1800)) })} /></div>
    <div className="setting-row"><div><strong>Maximum recording duration</strong><span>Audio remains in memory only until transcription finishes.</span></div><input aria-label="Maximum recording duration" type="number" min="5" max="120" value={preferences.voiceMaxRecordingSeconds} onChange={(event) => void updatePreferences({ voiceMaxRecordingSeconds: Math.max(5, Math.min(120, Number(event.target.value) || 60)) })} /></div>
    <div className="settings-section-title"><span><Volume2 size={17} /></span><div><h2>Browser-local speech</h2><p>Uses only voices the browser reports as local. No voice cloning or remote TTS is used.</p></div></div>
    <div className="setting-row"><div><strong>Voice</strong><span>{voices.length ? "Installed browser-local voices" : "No local browser voices reported"}</span></div><select aria-label="Browser speech voice" value={preferences.voiceOutputVoiceURI} onChange={(event) => void updatePreferences({ voiceOutputVoiceURI: event.target.value })}><option value="">Automatic local voice</option>{voices.map((voice) => <option value={voice.voiceURI} key={voice.voiceURI}>{voice.name} ({voice.lang})</option>)}</select></div>
    <div className="setting-row"><div><strong>Volume</strong><span>{Math.round(preferences.voiceOutputVolume * 100)}%</span></div><input aria-label="Speech volume" type="range" min="0" max="1" step="0.1" value={preferences.voiceOutputVolume} onChange={(event) => void updatePreferences({ voiceOutputVolume: Number(event.target.value) })} /></div>
    <div className="setting-row"><div><strong>Speech rate</strong><span>{preferences.voiceOutputRate.toFixed(1)}x</span></div><input aria-label="Speech rate" type="range" min="0.5" max="2" step="0.1" value={preferences.voiceOutputRate} onChange={(event) => void updatePreferences({ voiceOutputRate: Number(event.target.value) })} /></div>
    <div className="setting-row"><div><strong>Test local speech</strong><span>Completed assistant replies use this local browser engine when voice output is enabled.</span></div><Button variant="outline" disabled={!voices.length} onClick={testLocalSpeech}>Test speech <Volume2 size={14} /></Button></div>
    <div className="setting-row"><div><strong>Browser notifications</strong><span>{notificationPermission === "denied" ? "Denied; in-app notifications remain available." : notificationPermission === "granted" ? "Permission granted; delivery requires this page to remain open." : "Permission has not been requested."}</span></div><div><Badge tone={notificationPermission === "granted" ? "green" : notificationPermission === "denied" ? "amber" : "neutral"}>{notificationPermission}</Badge><Button variant="outline" disabled={notificationPermission === "unsupported" || notificationPermission === "granted"} onClick={() => void enableNotifications()}>Enable notifications</Button><label><input type="checkbox" checked={preferences.browserNotificationsEnabled} disabled={notificationPermission !== "granted"} onChange={(event) => void updatePreferences({ browserNotificationsEnabled: event.target.checked })} /> Enabled</label></div></div>
    <div className="setting-row"><div><strong>Choose a directory</strong><span>Selection is held only for this page and never grants backend filesystem access.</span></div><Button variant="outline" onClick={() => void selectDirectory()}><FolderOpen size={14} /> Choose directory</Button></div>
    <div className="setting-row"><div><strong>Browser selection</strong><span>{directoryName ? `${directoryName} (held for this page only)` : directoryStatus === "unsupported" ? "Picker unsupported; use operator-approved backend workspace configuration." : directoryStatus === "not_allowed" ? "Selection was not allowed. No backend access was granted." : directoryStatus === "blocked_or_unavailable" ? "Picker was blocked or unavailable; this does not establish organization policy." : directoryStatus === "cancelled" ? "Selection cancelled; no directory was retained." : "No browser directory selected."}</span></div><Badge tone={directoryStatus === "selected" ? "cyan" : directoryStatus === "not_allowed" || directoryStatus === "blocked_or_unavailable" ? "amber" : "neutral"}>{directoryStatus.replaceAll("_", " ")}</Badge></div>
    <div className="setting-row"><div><strong>Backend workspace approval</strong><span>{workspaceTools.length ? "Workspace tools are enabled, but the selected browser handle is not mapped to an approved path." : "Not verified. Workspace paths and permissions must be configured by the backend operator."}</span></div><Badge tone="amber">Backend authoritative</Badge></div>
  </Panel>;
}
