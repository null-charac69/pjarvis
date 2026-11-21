# Jarvis Desktop

Electron + React client for the local Jarvis API, including opt-in Phase 6 voice capture. Voice transcripts enter the existing assistant command endpoint; the desktop does not implement a separate planner or permission path.

## Run locally

Requirements: Node.js 22.12+, npm, and the repository's Python environment. Electron 44 requires Node 22.12 or newer.

Start the API from the repository root:

```powershell
uv run uvicorn app.main:app --app-dir apps/api --host 127.0.0.1 --port 8765
```

In another terminal:

```powershell
cd apps/desktop
npm ci
npm run dev
```

The Electron renderer's Vite server is available at `http://127.0.0.1:5173`; run the desktop app with `npm run dev`. The renderer proxies `/api` and `/ws` to the local API. Set `JARVIS_BACKEND_URL` in the Electron main-process environment to use a different trusted backend URL.

If Electron's runtime download fails with `unable to get local issuer certificate`, keep npm TLS verification enabled and obtain the PEM-encoded CA bundle approved by your organization. In the same PowerShell session used for installation:

```powershell
$env:NODE_EXTRA_CA_CERTS = 'C:\path\to\organization-approved-ca-bundle.pem'
Remove-Item Env:ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue
npm install
npm run dev
```

Do not disable certificate validation or use `npm install` to silently rewrite the lockfile. `npm ci` requires an approved CA bundle when the organization intercepts package downloads.

If the Electron npm package is already installed but `node_modules/electron/dist/electron.exe` is missing, run `npm rebuild electron` instead of `npm install`, then run `npm run dev`. Do not disable `strict-ssl`, set `NODE_TLS_REJECT_UNAUTHORIZED=0`, or commit the CA bundle. Keep the CA file in an organization-managed location.

For a browser-only renderer preview, use `npm run dev:renderer`. The Electron window controls and persistent main-process preferences are available only in the desktop runtime.

## Checks

```powershell
npm run typecheck
npm run typecheck:electron
npm test
npm run build
```

Windows packaging targets are `npm run package:win:dir`, `npm run package:win:nsis`, and `npm run package:win:portable`. They require the Electron runtime download and emit artifacts under `release/`. The current workspace has not completed an Electron runtime launch, installer install/uninstall, or code-signing test; see [release readiness](../../docs/RELEASE_READINESS.md) and [release procedure](../../RELEASE.md).

## Scope and security

- The renderer has no Node integration and uses a context-isolated, sandboxed preload bridge with explicit, validated IPC methods.
- External links are restricted to credential-free HTTP(S) URLs and opened by the main process.
- Backend tool schemas, permission tickets, grants, audit records, health, tasks, and assistant history remain authoritative. Sensitive operations are never approved locally around the backend.
- Microphone access is off by default and requested only after explicit action and consent. Push-to-talk uses bounded capture, measured local VAD, and the local API; wake monitoring is opt-in and requires a healthy local model. Raw audio is transient and is not stored or emitted in general events.
- Speech recognition requires an explicitly configured local faster-whisper model or Azure Speech. Browser speech synthesis is opt-in and selects only operating-system voices marked local; output routing uses the system default. Unavailable providers remain unavailable; the UI does not fabricate transcripts, detections, or microphone levels.
- Memory, file ingestion/indexing, OS metrics not published by the backend, scheduled automation, and provider configuration UI remain unavailable.
- Desktop preferences are stored by Electron on the local device. API credentials and provider secrets are not accepted or stored by the renderer.