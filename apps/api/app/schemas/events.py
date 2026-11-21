"""Typed server event envelopes shared by WebSocket publishers and clients."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from pydantic.alias_generators import to_camel

AssistantState = Literal[
    "idle",
    "listening",
    "transcribing",
    "thinking",
    "planning",
    "awaiting_confirmation",
    "executing",
    "speaking",
    "completed",
    "cancelled",
    "failed",
    "offline",
    "Sleeping",
    "Wake word detected",
    "Listening",
    "Transcribing",
    "Thinking",
    "Planning",
    "Awaiting confirmation",
    "Executing tool",
    "Speaking",
    "Completed",
    "Cancelled",
    "Error",
    "Offline",
]


class EventModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class EventPayload(EventModel):
    pass


class EventEnvelope(EventModel):
    schema_version: Literal[1] = 1
    event_id: UUID = Field(default_factory=uuid4)
    occurred_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    correlation_id: UUID


class AssistantStatePayload(EventPayload):
    state: AssistantState


class AssistantStateChanged(EventEnvelope):
    type: Literal["assistant.state.changed"]
    payload: AssistantStatePayload


class PlanStep(EventPayload):
    step_id: str
    description: str
    tool_id: str | None = None


class PlanCreatedPayload(EventPayload):
    plan_id: UUID
    steps: list[PlanStep]


class AssistantPlanCreated(EventEnvelope):
    type: Literal["assistant.plan.created"]
    payload: PlanCreatedPayload


class PartialResponsePayload(EventPayload):
    text: str
    sequence: int = Field(ge=0)


class AssistantResponsePartial(EventEnvelope):
    type: Literal["assistant.response.partial"]
    payload: PartialResponsePayload


class CompletedResponsePayload(EventPayload):
    message_id: UUID
    text: str


class AssistantResponseCompleted(EventEnvelope):
    type: Literal["assistant.response.completed"]
    payload: CompletedResponsePayload


class WakeWordPayload(EventPayload):
    phrase: str


class VoiceWakewordDetected(EventEnvelope):
    type: Literal["voice.wakeword.detected"]
    payload: WakeWordPayload


class VoiceRecordingStartedPayload(EventPayload):
    session_id: UUID


class VoiceRecordingStarted(EventEnvelope):
    type: Literal["voice.recording.started"]
    payload: VoiceRecordingStartedPayload


class VoiceRecordingStoppedPayload(EventPayload):
    session_id: UUID
    reason: Literal["completed", "cancelled", "timeout", "no_speech", "error"]


class VoiceRecordingStopped(EventEnvelope):
    type: Literal["voice.recording.stopped"]
    payload: VoiceRecordingStoppedPayload


class VoiceAudioLevelPayload(EventPayload):
    level: float = Field(ge=0, le=1)
    duration_ms: int = Field(ge=0)


class VoiceAudioLevel(EventEnvelope):
    type: Literal["voice.audio.level"]
    payload: VoiceAudioLevelPayload


class VoiceSpeechStartedPayload(EventPayload):
    session_id: UUID


class VoiceSpeechStarted(EventEnvelope):
    type: Literal["voice.speech.started"]
    payload: VoiceSpeechStartedPayload


class VoiceSpeechEndedPayload(EventPayload):
    session_id: UUID
    duration_ms: int = Field(ge=0)


class VoiceSpeechEnded(EventEnvelope):
    type: Literal["voice.speech.ended"]
    payload: VoiceSpeechEndedPayload


class PartialTranscriptPayload(EventPayload):
    text: str
    sequence: int = Field(ge=0)


class VoiceTranscriptPartial(EventEnvelope):
    type: Literal["voice.transcript.partial"]
    payload: PartialTranscriptPayload


class FinalTranscriptPayload(EventPayload):
    command_id: UUID
    text: str
    language: str


class VoiceTranscriptFinal(EventEnvelope):
    type: Literal["voice.transcript.final"]
    payload: FinalTranscriptPayload


class VoiceTranscriptionFailedPayload(EventPayload):
    session_id: UUID
    error_code: str


class VoiceTranscriptionFailed(EventEnvelope):
    type: Literal["voice.transcription.failed"]
    payload: VoiceTranscriptionFailedPayload


class PermissionRequestedPayload(EventPayload):
    confirmation_id: UUID
    tool_id: str
    risk_level: Literal["LOW", "MEDIUM", "HIGH", "BLOCKED"]


class PermissionRequested(EventEnvelope):
    type: Literal["permission.requested"]
    payload: PermissionRequestedPayload


class PermissionResolvedPayload(EventPayload):
    confirmation_id: UUID
    decision: Literal["approved_once", "approved_session", "denied"]


class PermissionResolved(EventEnvelope):
    type: Literal["permission.resolved"]
    payload: PermissionResolvedPayload


class ToolStartedPayload(EventPayload):
    tool_call_id: UUID
    tool_id: str


class ToolStarted(EventEnvelope):
    type: Literal["tool.started"]
    payload: ToolStartedPayload


class ToolProgressPayload(EventPayload):
    tool_call_id: UUID
    message: str
    progress: float | None = Field(default=None, ge=0, le=1)


class ToolProgress(EventEnvelope):
    type: Literal["tool.progress"]
    payload: ToolProgressPayload


class ToolCompletedPayload(EventPayload):
    tool_call_id: UUID
    summary: str
    duration_ms: int = Field(ge=0)


class ToolCompleted(EventEnvelope):
    type: Literal["tool.completed"]
    payload: ToolCompletedPayload


class ToolFailedPayload(EventPayload):
    tool_call_id: UUID
    error_code: str


class ToolFailed(EventEnvelope):
    type: Literal["tool.failed"]
    payload: ToolFailedPayload


class AudioPlaybackStartedPayload(EventPayload):
    playback_id: UUID


class AudioPlaybackStarted(EventEnvelope):
    type: Literal["audio.playback.started"]
    payload: AudioPlaybackStartedPayload


class AudioPlaybackStoppedPayload(EventPayload):
    playback_id: UUID
    reason: Literal["completed", "interrupted", "cancelled", "error"]


class AudioPlaybackStopped(EventEnvelope):
    type: Literal["audio.playback.stopped"]
    payload: AudioPlaybackStoppedPayload


class AudioPlaybackProgressPayload(EventPayload):
    playback_id: UUID
    progress: float = Field(ge=0, le=1)
    elapsed_ms: int = Field(ge=0)


class AudioPlaybackProgress(EventEnvelope):
    type: Literal["audio.playback.progress"]
    payload: AudioPlaybackProgressPayload


class AudioPlaybackCompletedPayload(EventPayload):
    playback_id: UUID


class AudioPlaybackCompleted(EventEnvelope):
    type: Literal["audio.playback.completed"]
    payload: AudioPlaybackCompletedPayload


class TaskUpdatedPayload(EventPayload):
    task_id: UUID
    status: Literal[
        "pending", "running", "awaiting_confirmation", "completed", "failed", "cancelled"
    ]


class TaskUpdated(EventEnvelope):
    type: Literal["task.updated"]
    payload: TaskUpdatedPayload


class SystemMetricUpdatedPayload(EventPayload):
    metric: str
    value: float
    unit: str


class SystemMetricUpdated(EventEnvelope):
    type: Literal["system.metric.updated"]
    payload: SystemMetricUpdatedPayload


class ProviderHealthChangedPayload(EventPayload):
    provider: str
    status: Literal["healthy", "degraded", "unavailable", "unconfigured"]


class ProviderHealthChanged(EventEnvelope):
    type: Literal["provider.health.changed"]
    payload: ProviderHealthChangedPayload


class VoiceProviderHealthChangedPayload(EventPayload):
    provider: Literal["stt", "tts", "vad", "wake_word"]
    status: Literal["healthy", "degraded", "unavailable", "unconfigured"]


class VoiceProviderHealthChanged(EventEnvelope):
    type: Literal["voice.provider.health.changed"]
    payload: VoiceProviderHealthChangedPayload


class NotificationCreatedPayload(EventPayload):
    notification_id: UUID
    severity: Literal["info", "warning", "error", "security"]
    title: str


class NotificationCreated(EventEnvelope):
    type: Literal["notification.created"]
    payload: NotificationCreatedPayload


EventContract = Annotated[
    AssistantStateChanged
    | AssistantPlanCreated
    | AssistantResponsePartial
    | AssistantResponseCompleted
    | VoiceWakewordDetected
    | VoiceRecordingStarted
    | VoiceRecordingStopped
    | VoiceAudioLevel
    | VoiceSpeechStarted
    | VoiceSpeechEnded
    | VoiceTranscriptPartial
    | VoiceTranscriptFinal
    | VoiceTranscriptionFailed
    | PermissionRequested
    | PermissionResolved
    | ToolStarted
    | ToolProgress
    | ToolCompleted
    | ToolFailed
    | AudioPlaybackStarted
    | AudioPlaybackProgress
    | AudioPlaybackCompleted
    | AudioPlaybackStopped
    | VoiceProviderHealthChanged
    | TaskUpdated
    | SystemMetricUpdated
    | ProviderHealthChanged
    | NotificationCreated,
    Field(discriminator="type"),
]

EVENT_ADAPTER: TypeAdapter[EventContract] = TypeAdapter(EventContract)
