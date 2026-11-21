"""Versioned assistant command, task, confirmation, and history APIs."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict

from app.orchestration.engine import AssistantOrchestrator, OrchestrationError
from app.orchestration.models import OrchestrationResult, UserCommand
from app.providers.llm import ProviderHealth
from app.schemas.common import ApiResponse
from app.services.permissions import ConfirmationChoice

router = APIRouter(tags=["assistant"])


class ResolveAssistantConfirmationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: ConfirmationChoice


def _orchestrator(request: Request) -> AssistantOrchestrator:
    from typing import cast

    return cast(AssistantOrchestrator, request.app.state.orchestrator)


def _request_id(request: Request) -> str:
    return str(getattr(request.state, "request_id", "unknown"))


def _raise_orchestration_error(exception: OrchestrationError) -> HTTPException:
    status_code = (
        status.HTTP_422_UNPROCESSABLE_CONTENT
        if exception.error_code in {"invalid_transcript", "transcript_too_long"}
        else status.HTTP_404_NOT_FOUND
        if exception.error_code
        in {
            "conversation_not_found",
            "task_not_found",
            "confirmation_not_found",
            "confirmation_unavailable",
        }
        else status.HTTP_503_SERVICE_UNAVAILABLE
        if exception.error_code == "audit_write_failed"
        else status.HTTP_409_CONFLICT
    )
    return HTTPException(status_code=status_code, detail="The assistant command is unavailable.")


@router.post(
    "/assistant/commands",
    response_model=ApiResponse[OrchestrationResult],
    status_code=status.HTTP_202_ACCEPTED,
)
async def submit_command(body: UserCommand, request: Request) -> ApiResponse[OrchestrationResult]:
    try:
        result = await _orchestrator(request).submit(body)
    except OrchestrationError as exception:
        raise _raise_orchestration_error(exception) from exception
    except ValueError as exception:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="The requested conversation is unavailable.",
        ) from exception
    return ApiResponse(request_id=_request_id(request), data=result)


@router.get(
    "/assistant/commands/{command_id}",
    response_model=ApiResponse[OrchestrationResult],
)
async def get_command(command_id: UUID, request: Request) -> ApiResponse[OrchestrationResult]:
    result = await _orchestrator(request).get_command(command_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Command was not found.")
    return ApiResponse(request_id=_request_id(request), data=result)


@router.get("/tasks/{task_id}", response_model=ApiResponse[OrchestrationResult])
async def get_task(task_id: UUID, request: Request) -> ApiResponse[OrchestrationResult]:
    result = await _orchestrator(request).get_task(task_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Task was not found.")
    return ApiResponse(request_id=_request_id(request), data=result)


@router.post(
    "/assistant/commands/{command_id}/confirmation",
    response_model=ApiResponse[OrchestrationResult],
    status_code=status.HTTP_202_ACCEPTED,
)
async def resolve_command_confirmation(
    command_id: UUID,
    body: ResolveAssistantConfirmationRequest,
    request: Request,
) -> ApiResponse[OrchestrationResult]:
    try:
        result = await _orchestrator(request).resolve_confirmation(command_id, body.decision)
    except OrchestrationError as exception:
        raise _raise_orchestration_error(exception) from exception
    return ApiResponse(request_id=_request_id(request), data=result)


@router.post("/tasks/{task_id}/cancel", response_model=ApiResponse[OrchestrationResult])
async def cancel_task(task_id: UUID, request: Request) -> ApiResponse[OrchestrationResult]:
    try:
        result = await _orchestrator(request).cancel_task(task_id)
    except OrchestrationError as exception:
        raise _raise_orchestration_error(exception) from exception
    return ApiResponse(request_id=_request_id(request), data=result)


@router.get("/assistant/history", response_model=ApiResponse[list[OrchestrationResult]])
async def execution_history(
    request: Request,
    conversation_id: UUID | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0, le=100_000),
) -> ApiResponse[list[OrchestrationResult]]:
    records = await _orchestrator(request).history(
        conversation_id=conversation_id, limit=limit, offset=offset
    )
    return ApiResponse(request_id=_request_id(request), data=records)


@router.get("/assistant/providers/llm/health", response_model=ApiResponse[ProviderHealth])
async def llm_health(request: Request) -> ApiResponse[ProviderHealth]:
    health = await _orchestrator(request).health_check()
    return ApiResponse(request_id=_request_id(request), data=health)
