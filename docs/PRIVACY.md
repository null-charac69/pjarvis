# Privacy

## Data Boundaries

The backend and SQLite database are local by default. Conversation transcripts are masked before persistence; task plans/results, audit events, reminder data, permission grants, and conversation metadata can remain on disk. Electron stores desktop preferences locally. The application does not include a general telemetry or analytics service.

Raw microphone audio is transient and is not persisted by the voice API or included in general events. Push-to-talk requires user action and microphone consent. Local faster-whisper and wake-word paths require operator-installed packages/models. If Azure Speech is explicitly configured, active utterances are sent to Azure; provider charges and retention are governed by that service and its operator configuration.

An explicitly selected remote LLM receives the request content needed to produce a plan/response. Brave Search receives the search query; Open-Meteo receives the location query; approved website retrieval sends a bounded unauthenticated HTTPS request to the approved origin. Review provider terms and organizational policy before enabling these flows. Browser speech synthesis uses an operating-system voice marked local when available; no app-selected output device is supported.

## Access and Retention

Tool access is mediated by backend permissions and exact-action confirmations. Workspace roots and website origins are operator-approved. Audit records are local and masked; they are not a substitute for a centrally managed immutable audit service. Database files, backups, and Electron preference files inherit the host user's filesystem protections.

The application does not provide a complete user-facing export/deletion workflow for all stored records. Operators should define retention, backup, access, and deletion procedures for the local database before collecting sensitive data. Do not store secrets in transcripts, workspace files intended for indexing, or tool results.

## Unavailable Integrations

Clipboard, screenshots, email, calendar, remote TTS, dynamic plugins, and memory indexing are not available as production data paths. Do not infer that a UI placeholder or configuration field provides those capabilities.

See [SECURITY.md](../SECURITY.md), [PROVIDER_SETUP.md](../PROVIDER_SETUP.md), and [operations](OPERATIONS.md).
