# Windows Setup

## Status

The local FastAPI backend and Electron/React desktop client target Windows. Static NSIS/portable packaging metadata and commands are present; a release artifact, Electron runtime launch, signing, and installer lifecycle have not been validated in this environment. Startup/tray integration and OS credential storage are not implemented.

## Prerequisites

Install Git, Python 3.12, uv, and Node.js 22.12+ using their official distribution channels. Electron 44 requires Node 22.12 or newer. Docker Desktop is optional and not required.

Verify the tools in PowerShell:

```powershell
py -3.12 --version
node --version
npm --version
git --version
uv --version
```

From the repository root, install backend dependencies and run the API:

```powershell
uv sync --group dev
uv run uvicorn app.main:app --app-dir apps/api --host localhost --port 8765
```

Check `http://localhost:8765/api/v1/health` for readiness. The first startup applies the Alembic baseline and creates the ignored local database at `data/jarvis.sqlite3`.

From the repository root, create a local environment file if you need to prepare provider settings:

```powershell
Copy-Item .env.example .env
```

The copied values are blank/mock selections and do not configure a live provider. `.env` is ignored by Git. Never place keys in frontend files, browser storage, or logs.

Run the Electron client from another terminal:

```powershell
cd apps/desktop
npm ci
npm run dev
```

For release validation, run `scripts/validate-release.ps1`; to create a Windows directory, NSIS, or portable package, use `scripts/package-windows.ps1 -Target dir|nsis|portable`. These commands require the locked dependencies and Electron runtime to be installed. Keep TLS verification enabled and follow the organization-approved CA procedure in [apps/desktop/README.md](apps/desktop/README.md).

The renderer-only preview is `npm run dev:renderer`; it does not provide Electron IPC, persistent preferences, or the global shortcut. To install optional local STT support, run `uv sync --group dev --extra voice-local` and configure a model directory that already exists. Azure STT is opt-in through `uv sync --group dev --extra voice-azure` plus backend-only environment variables. The app never downloads speech or wake models automatically. Wake monitoring also requires an operator-installed compatible openWakeWord runtime and an existing ONNX model path.

For managed devices where Electron cannot run, use the separate non-admin browser profile in [docs/browser-deployment.md](docs/browser-deployment.md). It binds only to `127.0.0.1`, uses `%LOCALAPPDATA%\JARVIS\data`, requires no system certificate changes, and leaves Edge installation/microphone policies untouched. Browser and PWA modes are additive; Electron remains available as before.

## Managed Device Browser Startup

With the approved runtimes and repository dependencies already available, start everything and open the default browser with one command:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-browser.ps1
```

If PowerShell scripts are blocked by organization policy, use `scripts\start-browser.cmd`. Neither command requests elevation or changes machine policy. Shut down only recorded JARVIS processes with `powershell -File .\scripts\stop-jarvis.ps1`. Optional checks are `scripts\check-environment.ps1` and `scripts\diagnose-browser-mode.ps1`. The default data directory is `%LOCALAPPDATA%\JARVIS\data`; set an absolute `$env:JARVIS_DATA_DIR` in the launching PowerShell process to choose another approved writable directory. Use the URL printed by the launcher because it selects a free loopback port when the preferred port is occupied.

## Development Status

Voice input is off until enabled in desktop Settings. The microphone permission handler allows audio-only access from the application window after explicit consent; device discovery prompts only on user action. Browser preview uses browser permissions and does not provide the Electron global shortcut. If Electron fails to download because of a certificate error, keep TLS verification enabled and follow the organization-approved CA procedure in [apps/desktop/README.md](apps/desktop/README.md); never disable certificate checks.

For provider and security design, see [PROVIDER_SETUP.md](PROVIDER_SETUP.md) and [SECURITY.md](SECURITY.md).