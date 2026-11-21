"""Validated command, plan, task, and assistant response contracts."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from app.tools.sdk import RiskLevel


class OrchestrationModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        str_strip_whitespace=True,
    )


class AssistantState(StrEnum):
    IDLE = "idle"
    LISTENING = "listening"
    TRANSCRIBING = "transcribing"
    THINKING = "thinking"
    PLANNING = "planning"
    AWAITING_CONFIRMATION = "awaiting_confirmation"
    EXECUTING = "executing"
    SPEAKING = "speaking"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"
    OFFLINE = "offline"


class TaskStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    AWAITING_CONFIRMATION = "awaiting_confirmation"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class IntentKind(StrEnum):
    DIRECT_RESPONSE = "direct_response"
    SINGLE_TOOL = "single_tool"
    MULTI_TOOL = "multi_tool"
    CLARIFICATION = "clarification"
    CANCELLATION = "cancellation"
    UNSUPPORTED = "unsupported"
    PROVIDER_UNAVAILABLE = "provider_unavailable"


class UserCommand(OrchestrationModel):
    transcript: str = Field(min_length=1, max_length=4000)
    conversation_id: UUID | None = None
    language: str | None = Field(default=None, min_length=2, max_length=32)


class Intent(OrchestrationModel):
    kind: IntentKind
    summary: str = Field(min_length=1, max_length=500)
    confidence: float = Field(default=1.0, ge=0, le=1)
    requires_tools: bool = False


class ToolCall(OrchestrationModel):
    tool_id: str = Field(pattern=r"^[a-z][a-z0-9_.-]{1,127}$")
    arguments: dict[str, Any] = Field(default_factory=dict)


class PlanStep(OrchestrationModel):
    step_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    description: str = Field(min_length=1, max_length=500)
    tool_call: ToolCall | None = None


class ExecutionPlan(OrchestrationModel):
    version: Literal[1] = 1
    plan_id: UUID = Field(default_factory=uuid4)
    steps: list[PlanStep] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def step_ids_are_unique(self) -> ExecutionPlan:
        step_ids = [step.step_id for step in self.steps]
        if len(step_ids) != len(set(step_ids)):
            raise ValueError("Execution plan step IDs must be unique.")
        return self


class LLMPlanProposal(OrchestrationModel):
    intent: Intent
    steps: list[PlanStep] = Field(default_factory=list, max_length=16)
    response_text: str | None = Field(default=None, max_length=4000)


class ToolResult(OrchestrationModel):
    tool_call_id: UUID
    tool_id: str
    status: Literal["succeeded", "failed", "denied", "timed_out", "unconfigured"]
    summary: str = Field(max_length=500)
    output: dict[str, Any] | None = None
    error_code: str | None = Field(default=None, max_length=64)
    duration_ms: int = Field(default=0, ge=0)
    untrusted_content: bool = False


class PermissionDecision(OrchestrationModel):
    decision: Literal["allowed", "confirmation_required", "denied"]
    scopes: list[str] = Field(default_factory=list)
    confirmation_id: UUID | None = None


class ConfirmationRequest(OrchestrationModel):
    confirmation_id: UUID
    tool_id: str
    risk_level: RiskLevel
    expires_at: datetime
    scopes: list[str] = Field(default_factory=list)
    masked_arguments: dict[str, Any] = Field(default_factory=dict)
    affected_resources: list[str] = Field(default_factory=list)


class AssistantMessage(OrchestrationModel):
    message_id: UUID = Field(default_factory=uuid4)
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class SpeechPayload(OrchestrationModel):
    text: str = Field(max_length=4000)
    language: str = Field(default="en-IN", min_length=2, max_length=32)
    provider: str
    status: Literal["ready", "mock", "unconfigured"]


class TaskEvent(OrchestrationModel):
    task_id: UUID
    command_id: UUID
    status: TaskStatus
    state: AssistantState
    occurred_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    detail: str | None = Field(default=None, max_length=500)


class AuditRecordReference(OrchestrationModel):
    record_id: UUID
    action: str
    outcome: str
    occurred_at: datetime


class OrchestrationResult(OrchestrationModel):
    command_id: UUID
    task_id: UUID
    conversation_id: UUID
    status: TaskStatus
    state: AssistantState
    intent: Intent | None = None
    plan: ExecutionPlan | None = None
    tool_results: list[ToolResult] = Field(default_factory=list)
    assistant_message: AssistantMessage | None = None
    speech_payload: SpeechPayload | None = None
    confirmation_request: ConfirmationRequest | None = None
    audit_records: list[AuditRecordReference] = Field(default_factory=list)
    error_code: str | None = Field(default=None, max_length=64)
