# Browser and PWA Deployment

## Scope

The browser profile runs the existing React renderer and local FastAPI service without launching Electron, installing a Windows service, changing machine certificates, or requiring administrator rights. Browser mode remains local to the current Windows user and binds both services to IPv4 loopback. It is not an internet-facing or multi-user deployment profile.

The PWA profile serves the production renderer build on loopback. The browser may offer installation as an app when the browser and organization policy permit it. Installation is optional; the app also works in a browser tab. Edge policy can disable service workers, PWA installation, microphone access, WebSockets, or local loopback behavior. JARVIS does not change or bypass those policies.

## Requirements

- Windows PowerShell 5.1 or newer, Node.js/npm, Python 3.12, and `uv`.
- Backend and desktop dependencies already installed for this checkout (`uv sync --group dev` and the desktop package dependencies).
- The existing project virtual environment at `.venv` and desktop Vite dependencies at `apps/desktop/node_modules`.
- A free loopback port pair. The supervisor prefers `8765` plus `5173` for browser mode or `8765` plus `4173` for PWA mode, and selects the next free port in a bounded range if either is occupied.

This profile uses the production settings profile (`developer_mode=false`, no automatic mock fallback, sandboxed workspaces, ask-every-time permissions). Configure providers in the backend `.env` only when needed. Provider secrets never enter frontend configuration, browser storage, URLs, or launch arguments. The existing host's trusted TLS configuration is left unchanged.

## Browser Mode

From the repository root, start the local API and browser renderer, then open the default browser:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-browser.ps1
```

If organization policy blocks PowerShell scripts, use the CMD fallback, which invokes the repository-local supervisor and already-installed Node.js:

```cmd
scripts\start-browser.cmd
```

The application uses the URL printed by the start script (normally `http://127.0.0.1:5173`). Check and stop only the processes launched by this profile with:

```powershell
.\scripts\status-browser.ps1
powershell -File .\scripts\stop-jarvis.ps1
```

The supervisor prefers the default ports and selects the next free loopback port in a bounded range if they are occupied. It records PIDs and command signatures for its own child processes and verifies ownership before stopping them; unrelated services are left running.

## PWA Mode

Build both browser and installable PWA renderer variants:

```powershell
.\scripts\build-browser.ps1
```

Start the static PWA preview and the production-configured local API:

```powershell
.\scripts\start-pwa.ps1
```

Open the URL printed by the start script (normally `http://127.0.0.1:4173`). To check and stop the PWA profile:

```powershell
node scripts\browser-mode.cjs status pwa
.\scripts\stop-pwa.ps1
```

`start-pwa.ps1` rebuilds the PWA before launch. PWA installation remains controlled by Edge and organizational policy; the install action appears only when the browser offers it. In Microsoft Edge, use that action if available, or open the Edge menu and choose **Apps → Install this site as an app**. If policy blocks installation or the option is absent, continue using the browser tab. Installation is optional and has not been verified on a managed organization device. A waiting service-worker update is applied only after an explicit user action.

## Local Data and Privacy

Browser deployment data is stored under `%LOCALAPPDATA%\JARVIS\data` by default. To use another user-approved writable location for one launch, set `$env:JARVIS_DATA_DIR` to an absolute path in that PowerShell process before starting JARVIS. The SQLite database, audit records, task history, and permission grants remain in the selected directory. Back up and remove it only according to the organization's retention requirements. The process ownership record is separate under `%LOCALAPPDATA%\JARVIS\run`; it contains process metadata, not credentials.

Browser API sessions use a random, short-lived token. The backend stores only its SHA-256 digest in memory; the renderer keeps the token in a module variable only. REST calls send it in `X-Jarvis-Session-Token`; WebSockets send it in the first bounded authentication frame. The token is never written to local/session storage, IndexedDB, URLs, or service-worker caches. Backend restart invalidates sessions and the renderer requests a replacement.

Browser API requests with an `Origin` header must match one configured origin exactly. Browsers can omit `Origin` on same-origin GET requests, so the browser guard permits that case only for a valid token from the current in-memory browser session, an exact loopback client (`127.0.0.1` or `::1`), an exact configured backend or renderer Host, and an explicitly allowlisted read-only GET route with no body. Bootstrap, WebSockets, and all state-changing requests still require an exact allowed Origin; missing-Origin writes and other routes are denied. No `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, or similar header is trusted. The browser profile disables Uvicorn proxy-header rewriting because no trusted reverse proxy is configured; Vite's development proxy rewrites Host to the configured loopback API authority and is not treated as an identity boundary.

The service worker caches only the application shell and content-hashed static assets. API requests, WebSocket traffic, provider output, task data, and credentials are network-only and are not cached. Browser voice capture requires a user action and browser microphone permission; raw audio remains transient under the configured backend voice path. Browser mode does not enable audio retention.

## Capability Limits

The in-app capability page reports browser features and backend provider readiness separately. Browser mode does not provide Electron window controls, system tray, global shortcuts, application launching, OS scheduling, background automation, arbitrary clipboard access, screenshots, or persistent desktop preferences. The page must remain open for browser interactions. The local API must remain running.

Microphone access is available only in a secure context. Loopback HTTP is considered a secure context by supported browsers, but an organization policy can still deny microphone permission. Voice transcription requires an operator-configured backend STT provider. Browser `SpeechRecognition` is not used as a hidden fallback; browser implementations may route audio to a browser-vendor service and require a separate privacy/policy decision. Browser speech synthesis uses installed browser voices and the system-default output device.

Backend permissions, explicit confirmations, audit, request limits, exact-origin checks, approved HTTPS retrieval origins, and workspace sandboxing remain authoritative. Browser mode adds a same-origin session boundary; it does not grant new backend capabilities or weaken existing controls.

## Verification

Run the focused browser security and renderer regression suites with:

```powershell
.\scripts\test-browser.ps1
```

This runs focused automated tests. Use `scripts/build-browser.ps1` for both production builds. Neither command validates Edge installation policy, microphone consent, real audio transcription, organizational approval, or general production readiness; those must be checked on the target device with the organization's approved procedures.
Use the [managed laptop validation checklist](managed-laptop-validation.md) to record the required browser, voice, notification, directory, privacy, and backend-authority checks. Automated diagnostics never request permission or approve an action.