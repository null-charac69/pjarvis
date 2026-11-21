# Contributing

## Current State

Phases 1–7 implement the FastAPI backend, Electron/React desktop, assistant orchestration, permission-gated tools, voice paths, and configured integration adapters. Phase 8 adds release hardening and validation; it does not imply general production readiness. Update the owning contract and user-facing status when behavior changes.

## Repository Layout

- `apps/desktop/`: Electron main/preload and React renderer.
- `apps/api/`: FastAPI backend, providers, orchestration, tools, permissions, memory, and persistence.
- `packages/`: shared types, Tool SDK, and UI components.
- `config/`: non-secret configuration profiles/schema.
- `docs/`: focused contracts and operational guidance.
- `infrastructure/`: later Docker and setup scripts.
- `tests/`: integration, security, and end-to-end tests.

## Engineering Expectations

Keep modules focused and normally below approximately 400 lines. Preserve public interfaces and keep changes scoped. Use strict TypeScript, typed API/WebSocket contracts, Pydantic v2 validation, structured logging, and dependency injection as components are implemented. Handle loading, offline, unconfigured, denied, and error states explicitly.

Security-sensitive behavior must fail closed. Never execute arbitrary LLM text, weaken permission checks, log secrets, or read outside approved workspaces. Treat web pages, documents, emails, and tool results as untrusted data. Update `SECURITY.md` and the relevant docs when changing a security boundary.

## Tests and Quality Gates

Tests must not call paid external APIs. Use mock providers and deterministic fixtures. Add unit tests for local logic, integration tests for API/events/storage boundaries, and security tests for validation and authorization. Backend gates are `uv lock --check`, `uv run pytest`, `uv run ruff check apps/api tests`, `uv run ruff format --check apps/api tests`, and `uv run mypy apps/api/app`. Desktop gates from `apps/desktop` are `npm ci`, `npm audit`, `npm run typecheck`, `npm run typecheck:electron`, `npm test`, and `npm run build`. Release procedures and environment-specific limitations are in [RELEASE.md](RELEASE.md) and [docs/RELEASE_READINESS.md](docs/RELEASE_READINESS.md).

## Changes

Keep configuration free of secrets and concrete machine-specific paths. Do not add generated databases, recordings, build output, or credentials. Explain user-visible limitations and update the README when implementation status changes.