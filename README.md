# Jarvis

A local-first desktop assistant for Windows, with practical WSL development support. The application pairs an Electron desktop client with a local FastAPI service and a permission-gated tool system; opt-in voice input and operating-system speech output are available when configured.

## Current Status

**Phases 1–8 are implemented and validated; release-host blockers remain documented.** An additive restricted Windows browser/PWA profile is also available; it does not replace Electron or change existing backend policy. The Python service has validated settings, async SQLite/Alembic, typed events, fail-closed permission/audit services, bounded built-in tools, structured assistant planning, confirmation-gated execution, masked history, and operator-configured providers. Integrations remain unavailable until credentials, models, roots, or allowlists are configured. Dynamic plugins and several OS integrations remain unimplemented. See [Phase 8 release readiness](docs/RELEASE_READINESS.md) and [browser/PWA deployment](docs/browser-deployment.md).

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for component ownership and data flow, [SECURITY.md](SECURITY.md) for security invariants, and [TOOL_DEVELOPMENT.md](TOOL_DEVELOPMENT.md) for the future plugin contract.

- Desktop: Electron, React, strict TypeScript, Tailwind CSS, shadcn/ui, Lucide, Framer Motion, Zustand, TanStack Query, React Router, and Recharts.
- Backend: Python 3.12, FastAPI, Pydantic v2, SQLAlchemy, Alembic, SQLite initially, optional PostgreSQL, WebSockets, and httpx.
- Local-first: a local backend owns providers, permissions, tools, memory, and audit records. The renderer does not receive provider credentials.
- Quality tools: pytest, Ruff, mypy, Vitest, strict TypeScript checks, and Electron/renderer builds.

## Prerequisites

Install Python 3.12, uv, Git, Node.js 22.12+, and npm. Electron 44 requires Node 22.12 or newer. Docker is optional; the current backend does not start containers.

Check the local toolchain in PowerShell:

```powershell
py -3.12 --version
node --version
npm --version
git --version
uv --version
```

Install the backend and development dependencies from the repository root:

```powershell
uv sync --group dev
```

The development profile works without a `.env` file. To override settings locally, copy and edit the template:

```powershell
Copy-Item .env.example .env
```

`.env` is ignored by Git. Provider secrets are parsed as secret values and are not included in settings representations or API errors. Do not put credentials in frontend configuration, source files, or logs. The template does not configure a live provider; operators supply any endpoint, model, deployment, and credential settings.

### Managed Windows Browser Startup

When Electron cannot run on a managed device, start browser mode without administrator access or certificate changes:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-browser.ps1
```

If organization policy blocks PowerShell scripts, use the CMD fallback:

```cmd
scripts\start-browser.cmd
```

Stop only JARVIS-owned processes with `powershell -File .\scripts\stop-jarvis.ps1`. Browser mode defaults data to `%LOCALAPPDATA%\JARVIS\data`; set `JARVIS_DATA_DIR` in the launching PowerShell process to use another absolute, user-approved writable directory. See [browser/PWA deployment](docs/browser-deployment.md) for PWA startup, permissions, diagnostics, and limitations.

## Development Startup

Start the local API from the repository root:

```powershell
uv run uvicorn app.main:app --app-dir apps/api --host localhost --port 8765
```

The service applies Alembic migrations at startup and stores its default SQLite database at `data/jarvis.sqlite3` (ignored by Git). Check readiness at `http://localhost:8765/api/v1/health`; liveness is at `/api/v1/health/live`. Tool discovery/execution, permissions, audit, assistant commands/tasks/history, and voice health/transcription/wake endpoints are available under `/api/v1`. `/ws/events` carries typed assistant, tool, task, permission, and voice events. Start the desktop from `apps/desktop` with `npm run dev`; see [apps/desktop/README.md](apps/desktop/README.md), [WINDOWS_SETUP.md](WINDOWS_SETUP.md), and [WSL_SETUP.md](WSL_SETUP.md).

An optional PostgreSQL driver group is available with `uv sync --group dev --group postgres`; configure `JARVIS_STORAGE__ENGINE=postgresql` and `JARVIS_DATABASE_URL` for that mode. The automated suite currently validates SQLite only; live PostgreSQL integration remains unverified.

## Provider Configuration

`config/development.toml`, `config/test.toml`, and `config/production.toml` are validated non-secret profiles. The backend loads the selected profile and overlays environment variables, including the flat names in `.env.example`. `config/provider.schema.json` describes the provider contract. Mock and operator-configured OpenAI-compatible/Azure OpenAI LLM adapters, optional STT and wake adapters, and renderer speech synthesis are implemented.

LLM options include the deterministic mock, a local vLLM or other OpenAI-compatible endpoint, and Azure OpenAI. STT may use an existing local faster-whisper model or explicitly configured Azure Speech; wake detection requires an existing local openWakeWord model. Speech synthesis uses the operating-system browser engine. Providers are never selected automatically and no model is downloaded by the application. See [PROVIDER_SETUP.md](PROVIDER_SETUP.md). Tests use local fakes and do not call paid APIs.

## Adding Tools

The typed SDK, registry, permissions, confirmation, workspace sandbox, bounded execution, audit capture, and initial built-ins are implemented. See [TOOL_DEVELOPMENT.md](TOOL_DEVELOPMENT.md) for the current contract and plugin limitations. Built-ins are `system.datetime`, `system.health`, `workspace.list`, `workspace.files`, `workspace.read`, `web.search`, `web.open_website`, and `development.git_status`.

## Permissions and Privacy

The implemented tool slice uses explicit scopes, fail-closed permission decisions, argument/resource-bound confirmation, approved workspace roots, exact HTTPS-origin allowlisting, and masked local audit records. Wake audio is processed by the configured local detector; captured utterances go only to the selected STT provider, with Azure used only when explicitly configured. Raw audio is transient and not retained. These protections apply to current tools and voice paths; future integrations require their own security review. See [SECURITY.md](SECURITY.md) and [docs/permission-model.md](docs/permission-model.md).

## Roadmap

1. Architecture, repository layout, configuration baseline, and documentation (complete).
2. FastAPI foundation, settings, database, logging, health APIs, and WebSocket event bus (complete).
3. Tool SDK, registry, permissions, audit, and initial safe tools (complete).
4. Orchestration, LLM providers, assistant APIs, and persistent task history (complete).
5. Electron/React shell and application pages (implemented).
6. Voice pipeline and state synchronization (implemented; live models remain operator-configured).
7. Real web, desktop, file, development, and monitoring tools.
8. Final testing, security hardening, packaging preparation, and release validation (in progress; release readiness is classified separately).

## Tests

Run the current backend tests and lint checks from the repository root:

```powershell
uv run pytest
uv run ruff check apps/api tests
uv run ruff format --check apps/api tests
uv run mypy apps/api/app
```

The backend tests use temporary SQLite databases and local mocks; desktop tests use Vitest/jsdom. These suites do not call paid external APIs or download speech models.

## Known Limitations

Live speech recognition and wake detection remain unconfigured until the operator supplies dependencies, credentials where applicable, and existing model files. Browser mode requires configured backend STT for voice and does not silently use browser-vendor SpeechRecognition. Browser speech synthesis uses installed browser voices and the system-default output. Confirmation tickets and the event hub are process-local; task/conversation history, audit records, and persistent permission grants are stored locally in SQLite. A process restart preserves task history but cannot resume an outstanding in-memory confirmation; interrupted persisted tasks are marked failed and are not resumed. Electron packaging metadata and scripts are prepared, but the Electron binary is absent in the current environment, so runtime launch, installer execution, signing, and installed-app smoke tests remain unverified. Edge PWA policy, managed microphone permission, and the browser-profile target-host smoke test remain unverified. Live provider credentials, PostgreSQL integration, and general production readiness are not established. See [operations](docs/OPERATIONS.md), [privacy](docs/PRIVACY.md), [release readiness](docs/RELEASE_READINESS.md), and [browser deployment](docs/browser-deployment.md).
