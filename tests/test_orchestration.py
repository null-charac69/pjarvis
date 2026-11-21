import pytest
from app.core.settings import Settings
from app.orchestration.engine import AssistantOrchestrator, OrchestrationError
from app.orchestration.models import (
    Intent,
    IntentKind,
    LLMPlanProposal,
    PlanStep,
    ToolCall,
)
from app.providers.mock import MockLLMProvider
from app.services.audit import AuditService
from app.services.conversations import ConversationService
from app.services.event_hub import EventHub
from app.services.permissions import PermissionService
from app.tools.builtin import create_builtin_tools
from app.tools.registry import ToolRegistry
from app.tools.workspaces import WorkspaceAccess


def test_plan_step_limit_is_checked_before_registry_or_permission_execution() -> None:
    settings = Settings(_env_file=None)
    database_factory = None
    orchestrator = AssistantOrchestrator(
        settings=settings,
        provider=MockLLMProvider(),
        registry=ToolRegistry(create_builtin_tools(settings)),
        permissions=PermissionService(database_factory, EventHub()),  # type: ignore[arg-type]
        audit=AuditService(database_factory),  # type: ignore[arg-type]
        conversations=ConversationService(database_factory),  # type: ignore[arg-type]
        event_hub=EventHub(),
        workspaces=WorkspaceAccess([]),
    )
    settings.orchestration.max_plan_steps = 1
    proposal = LLMPlanProposal(
        intent=Intent(
            kind=IntentKind.MULTI_TOOL,
            summary="Read time and health.",
            requires_tools=True,
        ),
        steps=[
            PlanStep(
                step_id="time",
                description="Read time.",
                tool_call=ToolCall(tool_id="system.datetime"),
            ),
            PlanStep(
                step_id="health",
                description="Read health.",
                tool_call=ToolCall(tool_id="system.health"),
            ),
        ],
    )

    with pytest.raises(OrchestrationError, match="plan_step_limit_exceeded"):
        orchestrator._validate_proposal(proposal)
