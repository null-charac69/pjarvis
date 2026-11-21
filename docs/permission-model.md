# Permission Model

## Status

The Phase 3 permission engine remains the single authorization authority in Phase 4. The orchestrator validates complete plans before execution, evaluates every tool through this service, and pauses for user confirmation when requested. The confirmation UI is not implemented; clients must show the masked confirmation details before resolving a request.

## Scopes

Explicit scopes include `microphone.listen`, `filesystem.read`, `filesystem.write`, `filesystem.delete`, `application.launch`, `shell.execute`, `browser.open`, `clipboard.read`, `clipboard.write`, `screenshot.capture`, `email.read`, `email.draft`, `email.send`, `calendar.read`, `calendar.write`, `network.search`, `productivity.read`, `productivity.write`, `system.control`, and `system.health.read`. Clipboard, screenshot, email, and calendar scopes have no registered integrations yet.

Each decision is scoped to a tool and resource. The configured default is Deny or Ask every time. A confirmation can approve once or for the active service session; session grants are held in memory and disappear when the service restarts. Explicit grants created through the grant API persist in the local database until revoked. Grants can only use scopes declared by the selected tool. Missing, malformed, expired, or ambiguous policy fails closed.

## Confirmation

Confirmation is mandatory for deleting or overwriting files, sending messages, creating commits, installing/uninstalling software, elevated commands, terminating processes, modifying system settings, downloading executables, financial/authentication actions, sensitive folders, and every `HIGH` risk action.

A request must show the tool, arguments with secrets masked, affected resources, risk level, and required scopes. Controls are approve once, approve for session, and deny. Confirmation is bound to the exact validated arguments and affected resources and expires after five minutes. Workspace overwrite/deletion, reminder creation/completion, application launch, and folder opening require confirmation. Direct tool clients use `POST /api/v1/tools/{tool_id}/execute`, `GET /api/v1/permissions/confirmations/{confirmation_id}`, and `POST /api/v1/permissions/confirmations/{confirmation_id}`. Assistant clients resolve a paused command through `POST /api/v1/assistant/commands/{command_id}/confirmation`; it delegates to the same permission service and resumes through the same tool registry. Events notify clients that a confirmation exists but do not authorize execution. Tickets remain in memory and are not resumable after a service restart.

## Audit and Events

The local append-only audit trail records request and tool-call IDs, policy decision, user resolution, masked arguments, affected resources, result summary, duration, and safe error codes. Its API supports paginated reads; it does not expose record mutation or deletion. Never record credentials, raw audio, or full sensitive file contents. Emit `permission.requested` and `permission.resolved` events without treating event receipt as authorization.

See [../SECURITY.md](../SECURITY.md) for security invariants and [event-contracts.md](event-contracts.md) for event envelopes.