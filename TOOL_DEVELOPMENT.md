# Tool Development

## Phase 7 Integrations

Built-ins execute only through `BaseTool`, `ToolRegistry`, `PermissionService`,
confirmation tickets, audit recording, and typed lifecycle events. Direct tool
calls and assistant plans use the same injected services and authorization
path.

Current integrations include:

- Date/time lookup and timezone conversion.
- Basic system health and real CPU, memory, and disk samples through `psutil`.
- Approved-workspace listing, bounded text read/search, atomic text write, and
single-file deletion. Writes and deletions require confirmation.
- Brave Search when selected and configured with `JARVIS_WEB_SEARCH_API_KEY`.
The explicit development mock is not live data and reports degraded health.
- Current weather from Open-Meteo; its responses include a source citation.
- Bounded webpage text retrieval only from operator-approved HTTPS origins.
DNS results are restricted to public IP addresses and pinned for the request;
redirects are revalidated, responses are size-bounded, and scripts are not
executed. Retrieved text is untrusted.
- Windows application launch from `permissions.approved_applications`, with no
model-supplied arguments, and Explorer opening only within approved workspace
roots. Both actions require confirmation.
- Fixed Git status, diff summary, and recent-log commands in approved workspace
roots. No arbitrary shell or command-line tool is exposed.
- Local reminders persisted in the application database. Listing is read-only;
creating and completing reminders require confirmation.

No provider silently falls back to fabricated data. A missing credential or
operator allowlist produces an explicit unconfigured/unavailable health or tool
result. Brave credentials are backend settings and are never returned in tool
outputs. Open-Meteo does not require a key.

## Boundaries

Workspace tools use canonical approved roots and reject traversal, symlink
escapes, sensitive paths, unsupported text types, and oversized content.
Retrieved pages, workspace data, Git output, search results, and reminder data
are untrusted content, not instructions or policy.

Clipboard and screenshot access require a consent-aware desktop IPC provider;
they are not exposed as backend tools in this phase. Email and calendar require
an explicit OAuth integration and currently remain unavailable. Do not report
those actions as successful. There is no dynamic plugin installation or
arbitrary custom-code execution. Custom tools are reviewed `BaseTool` code
registered in-process; the Tools page's test action uses the normal permission,
confirmation, audit, and execution path, not a fake sandbox.

## Manifest and Execution Contract

Each tool declares a stable ID, bounded Pydantic input/output models, category,
risk, least-privilege scopes, timeout, output bound, and confirmation policy.
The manifest cannot grant itself permission or alter global policy. Do not pass
model-generated shell text to a subprocess. Use fixed argument arrays, an
approved working directory, and strict output/time bounds for development
tools.

Tool code receives only injected capabilities through `ToolContext`. Add new
services to both direct API and orchestration context assembly. Never add a
parallel execution route that bypasses the registry.

## Tests

Use local fixtures and mocked HTTP responses; tests must not call paid APIs or
launch real applications. Cover schema rejection, exact confirmation binding,
grants and revocation, path and DNS restrictions, redirect validation, output
bounds, provider-unconfigured behavior, secret masking, audit records, and
failure/cancellation events.