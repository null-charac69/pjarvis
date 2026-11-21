import pytest
from app.orchestration.models import (
    AssistantMessage,
    AssistantState,
    AuditRecordReference,
    ConfirmationRequest,
    ExecutionPlan,
    Intent,
    OrchestrationResult,
    PermissionDecision,
    PlanStep,
    TaskEvent,
    ToolCall,
    ToolResult,
    UserCommand,
)
from pydantic import BaseModel, ValidationError


def test_required_orchestration_contracts_are_pydantic_models() -> None:
    models = (
        UserCommand,
        Intent,
        ExecutionPlan,
        PlanStep,
        ToolCall,
        ToolResult,
        PermissionDecision,
        ConfirmationRequest,
        AssistantMessage,
        TaskEvent,
        OrchestrationResult,
        AuditRecordReference,
    )

    assert all(issubclass(model, BaseModel) for model in models)
    assert {state.value for state in AssistantState} == {
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
    }


def test_command_and_plan_models_normalize_and_validate_input() -> None:
    command = UserCommand(transcript="  hello assistant  ")
    assert command.transcript == "hello assistant"

    with pytest.raises(ValidationError):
        UserCommand(transcript="   ")
    with pytest.raises(ValidationError):
        ExecutionPlan(
            steps=[
                PlanStep(step_id="same", description="first"),
                PlanStep(step_id="same", description="duplicate"),
            ]
        )
    with pytest.raises(ValidationError):
        ToolCall(tool_id="not valid", arguments={})
