# Security

## Status

This is the security design baseline. Phases 2-6 implement validated settings, local persistence, request correlation, voice boundaries, typed events, permissions, confirmations, and audit. Phase 7 adds configured Brave Search, Open-Meteo weather, approved-origin HTTPS retrieval, confirmed workspace mutations, allowlisted Windows app/folder opening, fixed Git read commands, real host metrics, workspace search, and local reminders. Phase 8 adds fail-closed production settings, junction-aware workspace traversal checks, cancellation-safe persistence, startup recovery of interrupted tasks, and Electron remote-backend HTTPS enforcement. Dynamic plugin installation remains unsupported. These controls have automated and static evidence, but do not constitute a penetration test or production certification.

## Assets and Threats

Protected assets include API credentials, private audio, files and clipboard contents, email/calendar data, permission grants, conversation/memory records, and the integrity of tool actions. Threats include malicious or misleading model output, prompt injection in webpages/documents/tool results, forged or replayed events, path traversal, argument injection, unauthorized access, command chaining, secret leakage, and accidental destructive actions.

## Required Invariants

- The LLM returns schema-constrained intent and plans only. It never directly executes generated shell text or invokes an unregistered tool.
- Validate tool IDs, arguments, paths, URL schemes, DNS destinations, redirects, and output sizes at the backend boundary. Treat retrieved content and tool results, including workspace, Git, and reminder data, as untrusted data, never as policy or system instructions.
- Tools have least-privilege scopes, explicit risk levels, bounded timeouts, and narrowly defined inputs/outputs. Applications, executables, folders, and workspaces use allowlists. Filesystem operations remain sandboxed to user-approved roots by default.
- Permission modes are deny or ask every time by default. Backend APIs support approve-once, approve-for-session, explicit persistent grants, and revocation. Session grants are in-memory and expire when the service restarts; persistent grants are specific to a tool, scope, and resource pattern. Confirmations expire and are bound to the exact validated arguments and affected resources. Clients retrieve masked arguments, resources, risk, and scopes before resolving a confirmation.
- Sensitive actions include file deletion/overwrite, application launch, opening folders, sending messages, commits, installation, elevated commands, process termination, system changes, executable downloads, financial/authentication actions, sensitive folders, and all high-risk commands. Push, merge, reset, branch deletion, and amend are never implicit.
- The renderer is untrusted. Electron uses context isolation and a narrow preload API; credentials stay out of renderer state, browser storage, URLs, and logs.
- Browser/PWA mode binds the API and renderer to IPv4 loopback, requires an exact configured origin, and uses a short-lived session token whose digest alone is retained by the API. The renderer keeps the token in memory; REST carries it in a header and WebSocket authentication uses the first bounded frame. API, WebSocket, task, audit, and file responses are excluded from the service-worker cache. The service worker caches only the shell and content-hashed assets.
- Audio is processed locally unless the user configures a remote speech provider and explicitly uses it. Do not continuously stream background audio to cloud services. Raw private audio is not retained unless the user explicitly enables it.
- Audit records are append-only through the application service and local by default. The API exposes paginated reads but no update/delete operation. Do not log passwords, tokens, API keys, raw private audio, or full sensitive file contents. Mask arguments before showing or recording them.
- Memory stores no secrets or raw credentials. Provide user inspection and deletion controls when memory is implemented.
- Backend network access is limited to configured provider and approved tool requests. Retrieved web content cannot trigger hidden navigation, downloads, or tool execution.
- Page retrieval is limited to operator-approved HTTPS origins. DNS answers must be globally routable and are pinned to the connection; every redirect is independently revalidated. Fetches send no ambient cookies or credentials, accept only bounded HTML, and do not execute scripts.
- Search uses Brave only when explicitly selected with an operator-provided key. Development mock results are labeled mock and report degraded health. Weather uses fixed Open-Meteo endpoints and includes citations.
- Clipboard, screenshots, email, and calendar are not registered tools until consent-aware desktop IPC or OAuth implementations exist. No arbitrary custom tool code is dynamically installed.

## Permission Scopes

Scopes include `microphone.listen`, `filesystem.read`, `filesystem.write`, `filesystem.delete`, `application.launch`, `shell.execute`, `browser.open`, `clipboard.read`, `clipboard.write`, `screenshot.capture`, `email.read`, `email.draft`, `email.send`, `calendar.read`, `calendar.write`, `network.search`, `productivity.read`, `productivity.write`, `system.control`, and `system.health.read`. Only scopes declared by an enabled tool can be granted through the API.

## Security Validation

Tests cover argument and path traversal, confirmation binding, grant denial/revocation, timeout/output bounds, secret redaction, provider-unconfigured behavior, audit records, SQLite cancellation/concurrency, restart recovery, junction traversal, and Electron URL/navigation policy. Browser security tests cover exact origins, session tokens, request limits, and WebSocket authentication/origin rejection. Prompt-injection behavior and client-side confirmation presentation remain future validation work. Tests use local fixtures/mocks and never depend on paid APIs. The current full npm tree has eight moderate advisories in build/packaging dependencies; the production-only tree has zero. Edge installation policy, managed microphone permission, live-provider use, Electron runtime/installer/signing, and penetration tests remain unverified. See [docs/permission-model.md](docs/permission-model.md), [docs/RELEASE_READINESS.md](docs/RELEASE_READINESS.md), and [CONTRIBUTING.md](CONTRIBUTING.md).
