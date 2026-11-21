import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, AudioLines, Check, ChevronDown, ClipboardCheck, ExternalLink, KeyRound, Mic, Palette, ShieldCheck, SlidersHorizontal, VolumeX } from "lucide-react";
import { usePreferences } from "@/hooks/usePreferences";
import { useLlmHealth } from "@/hooks/useBackend";
import { api } from "@/services/api";
import { browserFeatures, deploymentMode, isBrowserDeployment, pwaInstallAvailability, PWA_INSTALL_UNDETERMINED_MESSAGE } from "@/services/deployment";
import { enumerateAudioInputs } from "@/services/voice";
import { Badge, Button, PageHeading, Panel } from "@/components/ui";
import { Link } from "react-router-dom";
import { BrowserDeploymentPanel } from "@/components/BrowserDeploymentPanel";

export function SettingsPage() {
  const { preferences, updatePreferences, loaded } = usePreferences();
  const provider = useLlmHealth();
  const voice = useQuery({ queryKey: ["voice", "health"], queryFn: ({ signal }) => api.voiceHealth(signal) });
  const browser = isBrowserDeployment();
  const features = browserFeatures();
  const [saved, setSaved] = useState(false);
  const [audioInputs, setAudioInputs] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [deviceMessage, setDeviceMessage] = useState("");
  const [installStatus, setInstallStatus] = useState(pwaInstallAvailability);

  useEffect(() => {
    const refreshInstallStatus = () => setInstallStatus(pwaInstallAvailability());
    window.addEventListener("jarvis-pwa-install-available", refreshInstallStatus);
    window.addEventListener("jarvis-pwa-install-unavailable", refreshInstallStatus);
    window.addEventListener("jarvis-pwa-installed", refreshInstallStatus);
    return () => {
      window.removeEventListener("jarvis-pwa-install-available", refreshInstallStatus);
      window.removeEventListener("jarvis-pwa-install-unavailable", refreshInstallStatus);
      window.removeEventListener("jarvis-pwa-installed", refreshInstallStatus);
    };
  }, []);

  async function change(patch: Parameters<typeof updatePreferences>[0]) {
    await updatePreferences(patch);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

  async function discoverAudioInputs() {
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      setAudioInputs(await enumerateAudioInputs());
      setDeviceMessage("Microphone permission is active for this device.");
    } catch {
      setDeviceMessage("Microphone permission was not granted or no input is available.");
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  }

  return <div className="page-content settings-page">
    <PageHeading eyebrow="PREFERENCES / CONTROL" title="Settings" description="Desktop appearance and local preferences. Backend provider secrets are never collected here." action={saved ? <span className="saved-state"><Check size={15} /> Saved on this device</span> : undefined} />
    <Panel id="deployment" className="settings-section deployment-settings">
      <div className="settings-section-title"><span><ShieldCheck size={17} /></span><div><h2>Deployment</h2><p>Current runtime and browser-managed capability limits.</p></div></div>
      <div className="setting-row"><div><strong>Deployment mode</strong><span>{deploymentMode()}</span></div><Badge tone={browser ? "cyan" : "neutral"}>{browser ? "Browser Mode" : "Electron"}</Badge></div>
      <div className="setting-row"><div><strong>PWA installation</strong><span>{installStatus === "installed" ? "Installed standalone app" : installStatus === "available" ? "Install prompt available" : PWA_INSTALL_UNDETERMINED_MESSAGE}</span></div><Badge tone={installStatus === "installed" ? "green" : "neutral"}>{installStatus === "unavailable_or_not_offered" ? "undetermined" : installStatus}</Badge></div>
      <div className="setting-row"><div><strong>Browser capabilities</strong><span>Microphone API: {features.microphone ? "supported; permission still required" : "unavailable"} · TTS: {features.speechSynthesis ? "available" : "unavailable"} · secure context: {features.secureContext ? "yes" : "no"}</span></div></div>
      <div className="setting-row"><div><strong>Backend address</strong><span>{browser ? window.location.origin : "Configured by the desktop runtime"}</span></div></div>
      <div className="setting-row"><div><strong>Page-active requirement</strong><span>{browser ? "Keep this page open for voice capture and browser interactions." : "Desktop lifecycle is managed by Electron."}</span></div></div>
      <div className="setting-row"><div><strong>Provider status</strong><span>LLM: {provider.data?.status ?? "checking"} · STT: {voice.data?.stt.status ?? "checking"} · wake word: {voice.data?.wakeWord.status ?? "checking"}</span></div></div>
      <div className="setting-row"><div><strong>Organization policy</strong><span>JARVIS does not change browser installation, microphone, certificate, or network policy. Continue in a browser tab if PWA installation is unavailable.</span></div></div>
      <div className="setting-row"><div><strong>Install in Microsoft Edge</strong><span>When permitted, use the install icon or Edge menu → Apps → Install this site as an app. Installation is optional.</span></div></div>
      <div className="setting-row"><div><strong>Capability details</strong><span>Review provider readiness and desktop-only features.</span></div><Link className="text-link" to="/capabilities">System Capabilities</Link></div>
      {browser && <Link className="deployment-validation-card" to="/settings/deployment/validation">
        <span className="deployment-validation-icon"><ClipboardCheck size={18} /></span>
        <span className="deployment-validation-copy"><strong>Open Managed Device Validation</strong><small>Review the 22 capability checks and export a sanitized diagnostic report.</small></span>
        <ArrowRight size={17} aria-hidden="true" />
      </Link>}
    </Panel>
    {browser && <Panel className="settings-section"><div className="settings-section-title"><span><ExternalLink size={17} /></span><div><h2>Microsoft Edge installation (optional)</h2><p>Installation is controlled by Edge and organization policy. The browser tab remains supported.</p></div></div><ol><li>Open this JARVIS address in Microsoft Edge.</li><li>Use the application install action if Edge offers it, or choose <strong>Apps → Install this site as an app</strong> from the Edge menu.</li><li>If installation is unavailable or blocked, continue using this browser tab.</li></ol></Panel>}
    <div className="settings-layout"><nav className="settings-index" aria-label="Settings sections"><a href="#appearance"><Palette size={15} /> Appearance</a><a href="#accessibility"><SlidersHorizontal size={15} /> Accessibility</a><a href="#voice"><Mic size={15} /> Voice</a><a href="#providers"><KeyRound size={15} /> Providers</a><a href="#privacy"><ShieldCheck size={15} /> Privacy</a></nav>
      <div className="settings-sections"><Panel id="appearance" className="settings-section"><div className="settings-section-title"><span><Palette size={17} /></span><div><h2>Appearance</h2><p>Preferences are stored by the Electron main process.</p></div></div><div className="setting-row"><div><strong>Theme</strong><span>Choose the application color scheme.</span></div><select aria-label="Theme" value={preferences.theme} disabled={!loaded} onChange={(event) => void change({ theme: event.target.value as typeof preferences.theme })}><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option></select></div><div className="setting-row"><div><strong>Accent color</strong><span>Used for focus and active controls.</span></div><div className="accent-options">{(["cyan", "blue", "amber"] as const).map((accent) => <button key={accent} className={`accent-swatch swatch-${accent} ${preferences.accent === accent ? "selected" : ""}`} aria-label={`${accent} accent`} title={`${accent} accent`} onClick={() => void change({ accent })} />)}</div></div><div className="setting-row"><div><strong>Information density</strong><span>Adjust spacing in lists and tables.</span></div><select aria-label="Information density" value={preferences.density} onChange={(event) => void change({ density: event.target.value as typeof preferences.density })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></div><div className="setting-row"><div><strong>Interface scale</strong><span>{Math.round(preferences.fontScale * 100)}%</span></div><input aria-label="Interface scale" type="range" min="0.9" max="1.2" step="0.05" value={preferences.fontScale} onChange={(event) => void change({ fontScale: Number(event.target.value) })} /></div></Panel>
        <Panel id="accessibility" className="settings-section"><div className="settings-section-title"><span><SlidersHorizontal size={17} /></span><div><h2>Accessibility</h2><p>Motion and language preferences for the desktop interface.</p></div></div><div className="setting-row"><div><strong>Reduce motion</strong><span>Disable decorative rotation and transition effects.</span></div><label className="switch-control"><input type="checkbox" checked={preferences.reducedMotion} onChange={(event) => void change({ reducedMotion: event.target.checked })} /><span /></label></div><div className="setting-row"><div><strong>Language preference</strong><span>Stored locally; backend language selection remains per command.</span></div><input className="text-setting" value={preferences.language} maxLength={32} onChange={(event) => void change({ language: event.target.value })} aria-label="Preferred language" /></div><div className="setting-row"><div><strong>Timezone</strong><span>Used for local timestamps in the interface.</span></div><input className="text-setting" value={preferences.timezone} maxLength={64} onChange={(event) => void change({ timezone: event.target.value })} aria-label="Timezone" /></div></Panel>
        <Panel id="voice" className="settings-section"><div className="settings-section-title"><span><Mic size={17} /></span><div><h2>Voice</h2><p>Microphone access is requested only after an explicit action.</p></div></div><div className="setting-row"><div><strong>Allow microphone access</strong><span>Required for push-to-talk and wake-word monitoring.</span></div><label className="switch-control"><input type="checkbox" checked={preferences.microphoneAllowed} onChange={(event) => void change({ microphoneAllowed: event.target.checked, ...(event.target.checked ? {} : { wakeWordEnabled: false, voiceShortcutEnabled: false }) })} /><span /></label></div><div className="setting-row"><div><strong>Input device</strong><span>{deviceMessage || "Discover devices after allowing microphone access."}</span></div><div className="voice-device-control"><select aria-label="Microphone input" value={preferences.microphoneDeviceId} disabled={!preferences.microphoneAllowed} onChange={(event) => void change({ microphoneDeviceId: event.target.value })}><option value="">System default</option>{audioInputs.map((input) => <option value={input.deviceId} key={input.deviceId}>{input.label}</option>)}</select><Button variant="outline" disabled={!preferences.microphoneAllowed} onClick={() => void discoverAudioInputs()}>Detect</Button></div></div><div className="setting-row"><div><strong>Local wake-word monitoring</strong><span>{voice.data?.wakeWord.message ?? "Checking local wake-word provider…"}</span></div><label className="switch-control"><input type="checkbox" checked={preferences.wakeWordEnabled} disabled={!preferences.microphoneAllowed || voice.data?.wakeWord.status !== "healthy"} onChange={(event) => void change({ wakeWordEnabled: event.target.checked })} /><span /></label></div><div className="setting-row"><div><strong>Speak completed responses</strong><span>Uses the operating system speech engine in this desktop client.</span></div><label className="switch-control"><input type="checkbox" checked={preferences.voiceOutputEnabled} onChange={(event) => void change({ voiceOutputEnabled: event.target.checked })} /><span /></label></div><div className="setting-row"><div><strong>Global push-to-talk shortcut</strong><span>Ctrl+Shift+Space; available while the Jarvis window is open.</span></div><label className="switch-control"><input type="checkbox" checked={preferences.voiceShortcutEnabled} disabled={!window.jarvis || !preferences.microphoneAllowed} onChange={(event) => void change({ voiceShortcutEnabled: event.target.checked })} /><span /></label></div><div className="provider-status-row"><div><strong>Speech recognition</strong><span>{voice.data?.stt.message ?? voice.error?.message ?? "Checking local speech provider…"}</span></div><Badge tone={voice.data?.stt.status === "healthy" ? "green" : voice.data?.stt.status === "unconfigured" ? "amber" : "neutral"}>{voice.data?.stt.status ?? "unknown"}</Badge></div><Button variant="outline" onClick={() => void voice.refetch()}>Refresh voice health <ExternalLink size={13} /></Button></Panel>
        <Panel id="providers" className="settings-section"><div className="settings-section-title"><span><KeyRound size={17} /></span><div><h2>Provider status</h2><p>Provider configuration is managed by the backend operator.</p></div></div><div className="provider-status-row"><div><strong>Language model</strong><span>{provider.data?.message ?? provider.error?.message ?? "Checking backend health…"}</span></div><Badge tone={provider.data?.status === "healthy" ? "green" : provider.data?.status === "unconfigured" ? "amber" : "neutral"}>{provider.data?.status ?? "unknown"}</Badge></div><div className="provider-status-row"><div><strong>Speech recognition</strong><span>{voice.data?.stt.message ?? voice.error?.message ?? "Checking speech provider…"}</span></div><Badge tone={voice.data?.stt.status === "healthy" ? "green" : voice.data?.stt.status === "unconfigured" ? "amber" : "neutral"}>{voice.data?.stt.status ?? "unknown"}</Badge></div><div className="provider-status-row"><div><strong>Wake-word detection</strong><span>{voice.data?.wakeWord.message ?? "Checking wake-word provider…"}</span></div><Badge tone={voice.data?.wakeWord.status === "healthy" ? "green" : voice.data?.wakeWord.status === "unconfigured" ? "amber" : "neutral"}>{voice.data?.wakeWord.status ?? "unknown"}</Badge></div><div className="provider-unavailable"><VolumeX size={16} /><span>Provider credentials stay in backend configuration. faster-whisper processes audio locally; Azure Speech sends only the captured utterance to the configured Azure service. Temporary audio is deleted after processing.</span></div><Button variant="outline" onClick={() => { void provider.refetch(); void voice.refetch(); }}>Refresh provider health <ExternalLink size={13} /></Button></Panel>
        <Panel id="privacy" className="settings-section"><div className="settings-section-title"><span><ShieldCheck size={17} /></span><div><h2>Privacy & security</h2><p>Security boundaries enforced in this desktop client.</p></div></div><div className="privacy-list"><div><Check size={15} /><span>Renderer runs without Node integration, with context isolation and sandbox enabled.</span></div><div><Check size={15} /><span>Preferences remain in the OS-backed desktop store; credentials are not persisted by the UI.</span></div><div><Check size={15} /><span>Permission decisions and audit records are handled by the backend.</span></div></div><div className="profile-setting"><label htmlFor="profile-name">Local profile name</label><input id="profile-name" value={preferences.profileName} maxLength={64} onChange={(event) => void change({ profileName: event.target.value })} /><ChevronDown size={14} /></div></Panel></div></div>
    {browser && <BrowserDeploymentPanel />}
  </div>;
}