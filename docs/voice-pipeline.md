# Voice Pipeline

## Status

Phase 6 implements consent-gated microphone capture, renderer-local energy-based VAD, bounded transcription requests, typed voice lifecycle events, push-to-talk, optional local wake detection, and interruptible browser speech synthesis. Speech recognition is unconfigured until an operator selects and installs a supported provider and supplies an existing model or Azure credentials. There is no automatic model download. Speech synthesis uses only platform voices marked local and the operating-system default output; output-device routing is not implemented.

## Intended Flow

The renderer requests microphone access only after microphone consent and an explicit action or enabled wake-monitor preference. Local RMS-based VAD gates wake frames; only speech-active 16 kHz mono PCM frames are sent to the local API, and only when an actual wake model is healthy. Wake inference buffers are bounded while requests are in flight. Push-to-talk records a bounded, maximum-60-second utterance and stops on release, detected-speech silence, no-speech timeout, cancellation, or the 10 MiB capture cap. Audio-level events are coalesced to four updates per second. The API accepts only bounded WebM/WAV/OGG/MP4 audio and transcribes through the configured adapter. Temporary files are deleted after recognition; audio is never written to history, logs, audit records, or general events.

The final transcript is submitted through the existing `POST /api/v1/assistant/commands` orchestration path. Voice does not implement a planner, permission bypass, or parallel tool execution path. Partial transcripts are available only when the selected adapter supports repeated local transcription. Azure Speech is remote and is called only when explicitly selected and configured; it receives active utterance audio. Browser speech synthesis is opt-in and uses only installed voices marked local by the operating system. Unsupported or unconfigured adapters stay unavailable rather than fabricating output.

Wake phrase defaults to “Jarvis”; language defaults to `en-IN`. Wake monitoring is off by default. Push-to-talk and Ctrl+Shift+Space are fallback input paths. Wake monitoring pauses during task execution and speech output and resumes after completion or recoverable failures. Voice output can be interrupted. “Jarvis, stop” stops speech/playback; “Jarvis, cancel” or “Jarvis, cancel that” interrupts speech and requests cancellation of the active task. Cancellation is cooperative and does not imply rollback of an already-completed side effect.

## State Model

The states are `Sleeping`, `Wake word detected`, `Listening`, `Transcribing`, `Thinking`, `Planning`, `Awaiting confirmation`, `Executing tool`, `Speaking`, `Completed`, `Cancelled`, `Error`, and `Offline`. Backend task/assistant events and renderer-local capture/playback events update the UI; stale or disconnected state is shown as offline/unknown, never inferred as healthy.

A typical path is Sleeping -> Wake word detected -> Listening -> Transcribing -> Thinking -> Planning -> (Awaiting confirmation) -> Executing tool -> Speaking -> Completed. A command without a tool may skip execution. Denial, cancellation, provider failure, network loss, or tool error use explicit terminal/error paths. Wake/transcript events contain metadata and transcript text only; playback events contain IDs and reasons only.

## Privacy and UI

The UI distinguishes microphone consent, provider readiness, wake monitoring, active capture and duration, transcription, and playback. Partial and final transcript states are visible. Audio retention is currently always disabled, even if a legacy backend retention setting is enabled. Input-device enumeration happens only after user action; browser speech synthesis remains on the system-default output. Browser preview supports push-to-talk but not Electron's global shortcut or persisted preferences.

See [event-contracts.md](event-contracts.md) for voice events and [permission-model.md](permission-model.md) for microphone scope.