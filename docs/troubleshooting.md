# Troubleshooting

## Runtime Checks

The API, assistant/tool routes, event WebSocket, desktop shell, and opt-in voice capture are implemented. Optional speech/wake models are not bundled; health remains unavailable or unconfigured until the operator supplies dependencies, credentials, and existing model files.

## Environment Preparation

- `uv sync --group dev` fails: verify Python 3.12 and uv are installed, then inspect the resolver error; the command creates the project environment and lockfile.
- Backend startup fails: check `uv run uvicorn app.main:app --app-dir apps/api --host localhost --port 8765`; inspect the sanitized startup error and confirm the `data/` directory is writable.
- Health returns 503: `/api/v1/health/live` separates process liveness from database readiness. Check the configured database URL and filesystem permissions; do not paste database credentials into logs or support output.
- `.env` is missing: development defaults load from `config/development.toml`; copy `.env.example` only when you need overrides. Empty endpoints/credentials are intentional; no provider is configured.
- Voice provider reports unconfigured: check `GET /api/v1/voice/health`, `JARVIS_STT_PROVIDER`, `JARVIS_STT_MODEL_PATH`, and `JARVIS_WAKE_MODEL_PATH`. Model paths must already exist; Jarvis never downloads them.
- Microphone access is denied: enable microphone consent in desktop Settings, then retry the push-to-talk control. Wake monitoring has a separate opt-in switch and requires healthy wake-provider status.
- No audio devices are listed: select Detect in Settings after microphone consent. Device enumeration does not happen at app startup.
- Voice transcription returns 503: check STT health and confirm the optional provider package is installed. The API returns stable provider errors and does not log audio or provider response bodies.
- Azure STT unexpectedly incurs requests: each partial snapshot is a separate request; switch to local faster-whisper or stop recording. Azure is never selected automatically.
- Electron fails to start after npm install: verify that Electron's runtime binary exists. For `unable to get local issuer certificate`, use only the organization-approved CA instructions in `apps/desktop/README.md`; do not disable TLS verification.

## Later Runtime Diagnostics

## Browser Deployment

- `start-browser.ps1` reports missing runtimes or dependencies: run `scripts\check-environment.ps1`. The profile uses the repository `.venv` and existing Node/Vite installation; it does not install system software or request elevation.
- The browser starts on a port other than the default: the supervisor found an occupied preferred port and selected a free loopback port. Use the exact URL printed by startup and check `scripts\status-browser.ps1`.
- Startup reports that a profile is already running: inspect it with `scripts\status-browser.ps1`; stop only this project's recorded processes with `scripts\stop-jarvis.ps1` before restarting.
- Backend health is available but the page reports offline: keep the local API and renderer running, check the recorded profile status, and inspect browser policy for local loopback or WebSocket restrictions. Do not change organization policy to work around a denial.
- Microphone or PWA installation is unavailable: review the browser's site-permission UI or ask the organization administrator. Continue in the browser tab if installation is blocked. JARVIS does not modify certificate, microphone, or installation policy.
- Voice transcription is unavailable: configure an approved backend STT provider. Browser SpeechRecognition is not used as a fallback; microphone access alone does not provide transcription.
- Data is in an unexpected location: the default is `%LOCALAPPDATA%\JARVIS\data`. Set an absolute `$env:JARVIS_DATA_DIR` in the launching PowerShell process to select another approved writable location.

Check API health, then inspect WebSocket connectivity and correlation IDs. Voice event payloads contain transcript text and metadata, never raw audio. Keep secrets and sensitive file content out of logs and support bundles. Never work around a permission denial by invoking the underlying operation directly.

See [WINDOWS_SETUP.md](../WINDOWS_SETUP.md), [WSL_SETUP.md](../WSL_SETUP.md), [PROVIDER_SETUP.md](../PROVIDER_SETUP.md), and [SECURITY.md](../SECURITY.md).