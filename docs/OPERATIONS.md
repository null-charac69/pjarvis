# Operations

## Start and Health

Run the local API from the repository root:

```powershell
uv run uvicorn app.main:app --app-dir apps/api --host 127.0.0.1 --port 8765
```

Readiness is `GET /api/v1/health`; liveness is `GET /api/v1/health/live`. The API applies Alembic migrations before accepting traffic. A migration/startup failure is a release blocker; do not bypass it by deleting the database.

For a managed Windows browser profile, use `powershell -ExecutionPolicy Bypass -File .\scripts\start-browser.ps1`, or `scripts\start-browser.cmd` if script execution is blocked. The launcher starts the API and renderer, waits for health, and opens the default browser. It binds both listeners to `127.0.0.1` and prints the selected URL. Check with `scripts\status-browser.ps1`; stop only recorded JARVIS processes with `powershell -File .\scripts\stop-jarvis.ps1`. For the optional PWA preview, run `scripts\start-pwa.ps1`. PWA installation is optional and organization-controlled.

Run the desktop from `apps/desktop` with `npm run dev`, or use the Windows packaging procedure in [RELEASE.md](../RELEASE.md). The Electron client defaults to `http://localhost:8765`; remote backend origins must use HTTPS. The backend should remain bound to loopback unless a separately reviewed deployment adds authentication, TLS termination, and network access controls.

## Configuration and Providers

Use the non-secret TOML profiles and backend environment variables documented in [PROVIDER_SETUP.md](../PROVIDER_SETUP.md). Keep credentials in backend-only environment injection or an approved secret store. Production settings reject wildcard CORS origins and incomplete selected-provider configuration. Provider selections do not imply that models, SDKs, credentials, or remote endpoints are available; check the API health endpoints before enabling a workflow.

Approved workspaces, websites, applications, and providers are operator policy. Review these paths/origins for least privilege. Do not place wildcard roots or machine-specific secrets in committed configuration.

## Persistence and Recovery

The default database is `data/jarvis.sqlite3`. File-backed SQLite enables WAL and a bounded lock wait. Back up the database while the service is stopped or using a SQLite-consistent backup method; include any separately managed encrypted backup policy. Apply schema changes only through Alembic migrations.

Confirmation tickets and WebSocket clients are process-local. On startup, persisted tasks left pending, running, or awaiting confirmation are marked failed with `interrupted_by_restart`; they are never replayed. Users must submit a new request after reviewing the action state. Persistent grants and audit/task history remain in the local database.

## Logs and Shutdown

The backend uses structured application logging and request correlation IDs. Do not enable verbose payload logging in production or collect secrets, raw audio, or full sensitive file content. Shutdown closes the orchestrator and disposes the database engine even if cleanup raises; use the service manager's graceful-stop timeout before forced termination.

## Recovery Boundaries

No automatic database restore, multi-process SQLite coordination, scheduled background execution, remote monitoring, or PostgreSQL production runbook is supplied. Validate restore procedures and the chosen deployment model before a pilot.
