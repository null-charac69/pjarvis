# Event Contracts

## Status

Phases 2–6 implement the Pydantic typed event union, matching strict TypeScript voice/playback schemas, an in-memory event hub, and `/ws/events`. Backend voice endpoints publish wake detection, partial/final transcripts, provider-health transitions, and safe transcription failures. Recording/VAD and browser playback lifecycle events are renderer-local notifications. Events never grant permission or replace an authoritative API response. The hub is process-local and ephemeral; it is not an audit log or durable event store.

## Envelope

Every event has a schema version, unique event identifier, UTC occurrence timestamp, correlation identifier, event type, and event-specific typed payload. Consumers validate the envelope and payload, ignore unknown optional fields, and handle unknown event types without crashing. Event data is minimized and must not include secrets, raw audio, or full sensitive file content.

```json
{
  "schemaVersion": 1,
  "eventId": "generated-event-id",
  "occurredAt": "UTC timestamp",
  "correlationId": "request-or-task-id",
  "type": "assistant.state.changed",
  "payload": {}
}
```

The values above are illustrative placeholders, not production IDs or timestamps.

## Event Types

- Assistant: `assistant.state.changed`, `assistant.plan.created`, `assistant.response.partial`, `assistant.response.completed`
- Voice: `voice.wakeword.detected`, `voice.recording.started`, `voice.recording.stopped`, `voice.audio.level`, `voice.speech.started`, `voice.speech.ended`, `voice.transcript.partial`, `voice.transcript.final`, `voice.transcription.failed`, `voice.provider.health.changed`
- Permissions: `permission.requested`, `permission.resolved`
- Tools: `tool.started`, `tool.progress`, `tool.completed`, `tool.failed`
- Audio: `audio.playback.started`, `audio.playback.progress`, `audio.playback.completed`, `audio.playback.stopped`
- Tasks and system: `task.updated`, `system.metric.updated`, `provider.health.changed`, `notification.created`

Payloads carry stable identifiers, state/status, safe progress/result summaries, and timestamps where useful. Audio-level updates are throttled to at most four per second. Voice payloads may contain recognized transcript text but never raw audio, device labels, provider credentials, or audio buffers. Playback payloads contain IDs, progress, elapsed time, and stop reasons only. Voice and playback payload validation rejects extra fields.

## Delivery Expectations

Backend events use `/ws/events`; a client may send `{"type":"ping"}` and receives `{"type":"pong"}`. Server publishers validate typed events before fan-out. Renderer-local recording, VAD, and speech-synthesis events enter the local event timeline and are not sent back to the server. Audio is sent only through bounded REST requests; there is no audio WebSocket or durable audio store. Clients must handle reconnects, duplicate delivery, out-of-order updates, and stale connections. Use event/task IDs for idempotent UI updates and refetch authoritative state after reconnect. Offline/disconnected status is visible. Do not claim exactly-once delivery.
