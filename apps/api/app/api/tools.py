"""Tool execution, permission management, and audit HTTP endpoints."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import AliasChoices, BaseModel, Field, ValidationError

from app.models.audit import AuditRecord, PermissionGrantRecord
from app.schemas.common import ApiResponse
from app.schemas.events import (
    ToolCompleted,
    ToolCompletedPayload,
    ToolFailed,
    ToolFailedPayload,
    ToolStarted,
    ToolStartedPayload,
)
from app.services.audit import AuditService
from app.services.permissions import (
    ConfirmationChoice,
    ConfirmationTicket,
    PermissionDecision,
    PermissionService,
)
from app.tools.registry import (
    DisabledToolError,
    InvalidToolArgumentsError,
    ToolExecutionError,
    ToolRegistry,
    UnknownToolError,
)
from app.tools.sdk import (
    PermissionScope,
    RiskLevel,
    ToolContext,
    ToolOutput,
    ToolResult,
    ToolStatus,
)
from app.tools.security import mask_secrets

router = APIRouter(tags=["tools"])


class ToolItem(BaseModel):
    manifest: dict[str, Any]
    enabled: bool
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]


class ExecuteToolRequest(BaseModel):
    arguments: dict[str, Any] = Field(default_factory=dict)
    confirmation_id: UUID | None = Field(
        default=None,
        validation_alias=AliasChoices("confirmationId", "confirmation_id"),
    )


class ResolveConfirmationRequest(BaseModel):
    decision: ConfirmationChoice


class SetToolEnabledRequest(BaseModel):
    enabled: bool


class CreateGrantRequest(BaseModel):
    tool_id: str = Field(min_length=2, max_length=128)
    scope: PermissionScope
    resource_pattern: str = Field(default="*", min_length=1, max_length=512)


class ToolExecutionData(BaseModel):
    result: ToolResult[ToolExecutionPayload]
    confirmation_id: UUID | None = Field(default=None, serialization_alias="confirmationId")
    tool_call_id: UUID | None = Field(default=None, serialization_alias="toolCallId")


class ConfirmationData(BaseModel):
    confirmation_id: UUID
    tool_id: str
    risk_level: RiskLevel
    expires_at: datetime
    scopes: list[str]
    masked_arguments: dict[str, Any]
    affected_resources: list[str]
    decision: ConfirmationChoice | None = None


class GrantData(BaseModel):
    id: UUID
    tool_id: str
    scope: str
    resource_pattern: str
    created_at: datetime


class AuditData(BaseModel):
    id: UUID
    occurred_at: datetime
    request_id: UUID
    tool_call_id: UUID | None
    tool_id: str
    action: str
    outcome: str
    decision: str | None
    confirmation_id: UUID | None
    permission_scopes: list[str]
    affected_resources: list[str]
    masked_arguments: dict[str, Any]
    result_summary: str | None
    error_code: str | None
    duration_ms: int | None


class ToolExecutionPayload(ToolOutput):
    output: dict[str, Any]


def _request_id(request: Request) -> UUID:
    try:
        return UUID(str(request.state.request_id))
    except (AttributeError, ValueError):
        return uuid4()


def _audit(request: Request) -> AuditService:
    from typing import cast

    return cast(AuditService, request.app.state.audit_service)


def _registry(request: Request) -> ToolRegistry:
    from typing import cast

    return cast(ToolRegistry, request.app.state.tool_registry)


def _permissions(request: Request) -> PermissionService:
    from typing import cast

    return cast(PermissionService, request.app.state.permission_service)


def _audit_data(record: AuditRecord) -> AuditData:
    return AuditData.model_validate(record, from_attributes=True)


def _grant_data(grant: PermissionGrantRecord) -> GrantData:
    return GrantData.model_validate(grant, from_attributes=True)


@router.get("/tools", response_model=ApiResponse[list[ToolItem]])
async def list_tools(request: Request) -> ApiResponse[list[ToolItem]]:
    items = [
        ToolItem(
            manifest=entry.manifest.model_dump(mode="json"),
            enabled=entry.enabled,
            input_schema=entry.input_schema,
            output_schema=entry.output_schema,
        )
        for entry in _registry(request).list_tools()
    ]
    return ApiResponse(request_id=str(_request_id(request)), data=items)


@router.get("/tools/{tool_id}/health")
async def tool_health(tool_id: str, request: Request) -> ApiResponse[dict[str, Any]]:
    try:
        health = await _registry(request).health(tool_id)
    except UnknownToolError as exception:
        raise HTTPException(status_code=404, detail="Unknown tool.") from exception
    return ApiResponse(
        request_id=str(_request_id(request)),
        data=health.model_dump(mode="json"),
    )


@router.patch("/tools/{tool_id}/enabled")
async def set_tool_enabled(
    tool_id: str, body: SetToolEnabledRequest, request: Request
) -> ApiResponse[dict[str, bool | str]]:
    try:
        enabled = _registry(request).set_enabled(tool_id, body.enabled)
    except UnknownToolError as exception:
        raise HTTPException(status_code=404, detail="Unknown tool.") from exception
    return ApiResponse(
        request_id=str(_request_id(request)),
        data={"tool_id": tool_id, "enabled": enabled},
    )


@router.post("/tools/{tool_id}/execute", response_model=ApiResponse[ToolExecutionData])
async def execute_tool(
    tool_id: str, body: ExecuteToolRequest, request: Request
) -> ApiResponse[ToolExecutionData]:
    request_id = _request_id(request)
    registry = _registry(request)
    audit = _audit(request)
    permission_service = _permissions(request)
    try:
        tool = registry.get(tool_id)
    except (UnknownToolError, DisabledToolError) as exception:
        code = "unknown_tool" if isinstance(exception, UnknownToolError) else "tool_disabled"
        await audit.append(
            request_id=request_id,
            tool_id=tool_id,
            action="execute",
            outcome="denied",
            arguments=body.arguments,
            error_code=code,
        )
        raise HTTPException(
            status_code=404 if code == "unknown_tool" else 409,
            detail="Tool is unavailable.",
        ) from exception

    try:
        arguments = tool.input_model.model_validate(body.arguments)
    except ValidationError as exception:
        await audit.append(
            request_id=request_id,
            tool_id=tool_id,
            action="execute",
            outcome="denied",
            arguments=body.arguments,
            error_code="invalid_arguments",
        )
        raise HTTPException(status_code=422, detail="Tool arguments are invalid.") from exception

    argument_data = arguments.model_dump(mode="json")
    try:
        resources = tuple(tool.affected_resources(arguments))
    except ToolExecutionError as exception:
        await audit.append(
            request_id=request_id,
            tool_id=tool_id,
            action="execute",
            outcome="denied",
            decision="denied",
            arguments=argument_data,
            error_code=exception.error_code,
        )
        result = ToolResult[ToolExecutionPayload](
            status=ToolStatus.DENIED,
            summary="Tool request is not permitted.",
            error_code=exception.error_code,
            request_id=request_id,
        )
        return ApiResponse(
            request_id=str(request_id),
            data=ToolExecutionData(result=result),
        )
    permission = await permission_service.evaluate(
        tool.manifest,
        argument_data,
        resources,
        request_id,
        body.confirmation_id,
    )
    if permission.decision != PermissionDecision.ALLOWED:
        outcome = permission.decision.value
        await audit.append(
            request_id=request_id,
            tool_id=tool_id,
            action="execute",
            outcome=outcome,
            decision=outcome,
            confirmation_id=permission.confirmation_id,
            permission_scopes=[scope.value for scope in tool.manifest.required_scopes],
            affected_resources=resources,
            arguments=argument_data,
        )
        status_value = (
            ToolStatus.CONFIRMATION_REQUIRED
            if permission.decision == PermissionDecision.CONFIRMATION_REQUIRED
            else ToolStatus.DENIED
        )
        result = ToolResult[ToolExecutionPayload](
            status=status_value,
            summary=(
                "User confirmation is required."
                if status_value == ToolStatus.CONFIRMATION_REQUIRED
                else "Permission denied."
            ),
            request_id=request_id,
        )
        return ApiResponse(
            request_id=str(request_id),
            data=ToolExecutionData(result=result, confirmation_id=permission.confirmation_id),
        )

    tool_call_id = uuid4()
    await audit.append(
        request_id=request_id,
        tool_call_id=tool_call_id,
        tool_id=tool_id,
        action="execute_intent",
        outcome="authorized",
        decision="approved",
        confirmation_id=permission.confirmation_id,
        permission_scopes=[scope.value for scope in tool.manifest.required_scopes],
        affected_resources=resources,
        arguments=argument_data,
    )
    await request.app.state.event_hub.publish(
        ToolStarted(
            type="tool.started",
            correlation_id=request_id,
            payload=ToolStartedPayload(tool_call_id=tool_call_id, tool_id=tool_id),
        )
    )
    started = datetime.now(UTC)

    async def append_terminal_audit(
        *,
        outcome: str,
        error_code: str | None = None,
        result_summary: str | None = None,
        duration_ms: int,
    ) -> None:
        try:
            await audit.append(
                request_id=request_id,
                tool_call_id=tool_call_id,
                tool_id=tool_id,
                action="execute_result",
                outcome=outcome,
                decision="approved",
                confirmation_id=permission.confirmation_id,
                permission_scopes=[scope.value for scope in tool.manifest.required_scopes],
                affected_resources=resources,
                arguments=argument_data,
                result_summary=result_summary,
                error_code=error_code,
                duration_ms=duration_ms,
            )
        except Exception:
            await request.app.state.event_hub.publish(
                ToolFailed(
                    type="tool.failed",
                    correlation_id=request_id,
                    payload=ToolFailedPayload(
                        tool_call_id=tool_call_id,
                        error_code="audit_write_failed",
                    ),
                )
            )
            raise

    context = ToolContext(
        request_id=request_id,
        services={
            **request.app.state.tool_integrations,
            "settings": request.app.state.settings,
            "workspaces": request.app.state.workspaces,
            "web_search_provider": request.app.state.settings.providers.web_search,
        },
    )
    try:
        output, _, _ = await registry.execute(tool_id, argument_data, context)
    except asyncio.CancelledError:
        elapsed_ms = int((datetime.now(UTC) - started).total_seconds() * 1000)
        await append_terminal_audit(
            outcome="cancelled",
            error_code="tool_cancelled",
            duration_ms=elapsed_ms,
        )
        await request.app.state.event_hub.publish(
            ToolFailed(
                type="tool.failed",
                correlation_id=request_id,
                payload=ToolFailedPayload(tool_call_id=tool_call_id, error_code="tool_cancelled"),
            )
        )
        raise
    except (InvalidToolArgumentsError, ToolExecutionError) as exception:
        elapsed_ms = int((datetime.now(UTC) - started).total_seconds() * 1000)
        code = (
            exception.error_code
            if isinstance(exception, ToolExecutionError)
            else "invalid_arguments"
        )
        status_value = (
            ToolStatus.TIMED_OUT
            if code.endswith("timed_out")
            else ToolStatus.UNCONFIGURED
            if code == "provider_unconfigured"
            else ToolStatus.FAILED
        )
        await append_terminal_audit(
            outcome=status_value.value,
            error_code=code,
            duration_ms=elapsed_ms,
        )
        await request.app.state.event_hub.publish(
            ToolFailed(
                type="tool.failed",
                correlation_id=request_id,
                payload=ToolFailedPayload(tool_call_id=tool_call_id, error_code=code),
            )
        )
        result = ToolResult[ToolExecutionPayload](
            status=status_value,
            summary="Tool execution did not complete.",
            error_code=code,
            duration_ms=elapsed_ms,
            request_id=request_id,
        )
    else:
        elapsed_ms = int((datetime.now(UTC) - started).total_seconds() * 1000)
        output_data = mask_secrets(output.model_dump(mode="json"))
        serialized_output = {str(key): value for key, value in output_data.items()}
        result = ToolResult[ToolExecutionPayload](
            status=ToolStatus.SUCCEEDED,
            summary="Tool execution completed.",
            data=ToolExecutionPayload(output=serialized_output),
            duration_ms=elapsed_ms,
            untrusted_content=tool.manifest.category.value
            in {"web_information", "filesystem", "development", "productivity"},
            request_id=request_id,
        )
        await append_terminal_audit(
            outcome="succeeded",
            result_summary=result.summary,
            duration_ms=elapsed_ms,
        )
        await request.app.state.event_hub.publish(
            ToolCompleted(
                type="tool.completed",
                correlation_id=request_id,
                payload=ToolCompletedPayload(
                    tool_call_id=tool_call_id,
                    summary=result.summary,
                    duration_ms=elapsed_ms,
                ),
            )
        )

    return ApiResponse(
        request_id=str(request_id),
        data=ToolExecutionData(
            result=result,
            confirmation_id=permission.confirmation_id,
            tool_call_id=tool_call_id,
        ),
    )


@router.post("/permissions/confirmations/{confirmation_id}")
async def resolve_confirmation(
    confirmation_id: UUID, body: ResolveConfirmationRequest, request: Request
) -> ApiResponse[ConfirmationData]:
    async def record_resolution(ticket: ConfirmationTicket) -> None:
        await _audit(request).append(
            request_id=_request_id(request),
            tool_id=ticket.tool_id,
            action="permission_confirmation",
            outcome=body.decision.value,
            decision=body.decision.value,
            confirmation_id=confirmation_id,
            permission_scopes=[scope.value for scope in ticket.scopes],
            affected_resources=ticket.resources,
        )

    try:
        ticket = await _permissions(request).resolve(
            confirmation_id,
            body.decision,
            _request_id(request),
            before_resolve=record_resolution,
        )
    except ValueError as exception:
        raise HTTPException(status_code=404, detail="Confirmation is unavailable.") from exception
    return ApiResponse(
        request_id=str(_request_id(request)),
        data=ConfirmationData(
            confirmation_id=confirmation_id,
            tool_id=ticket.tool_id,
            risk_level=ticket.risk_level,
            expires_at=ticket.expires_at,
            scopes=[scope.value for scope in ticket.scopes],
            masked_arguments=ticket.masked_arguments,
            affected_resources=list(ticket.masked_resources),
            decision=body.decision,
        ),
    )


@router.get("/permissions/confirmations/{confirmation_id}")
async def get_confirmation(
    confirmation_id: UUID, request: Request
) -> ApiResponse[ConfirmationData]:
    ticket = _permissions(request).get_confirmation(confirmation_id)
    if ticket is None:
        raise HTTPException(status_code=404, detail="Confirmation is unavailable.")
    return ApiResponse(
        request_id=str(_request_id(request)),
        data=ConfirmationData(
            confirmation_id=confirmation_id,
            tool_id=ticket.tool_id,
            risk_level=ticket.risk_level,
            expires_at=ticket.expires_at,
            scopes=[scope.value for scope in ticket.scopes],
            masked_arguments=ticket.masked_arguments,
            affected_resources=list(ticket.masked_resources),
            decision=ticket.decision,
        ),
    )


@router.get("/permissions/grants")
async def list_grants(request: Request) -> ApiResponse[list[GrantData]]:
    grants = await _permissions(request).list_grants()
    return ApiResponse(
        request_id=str(_request_id(request)),
        data=[_grant_data(grant) for grant in grants],
    )


@router.post("/permissions/grants", status_code=status.HTTP_201_CREATED)
async def create_grant(body: CreateGrantRequest, request: Request) -> ApiResponse[GrantData]:
    try:
        tool = _registry(request).get(body.tool_id)
    except (UnknownToolError, DisabledToolError) as exception:
        raise HTTPException(status_code=404, detail="Tool is unavailable.") from exception
    if (
        body.scope not in tool.manifest.required_scopes
        or tool.manifest.risk_level == RiskLevel.BLOCKED
    ):
        raise HTTPException(status_code=422, detail="Grant does not match a permitted tool scope.")
    grant = await _permissions(request).add_grant(body.tool_id, body.scope, body.resource_pattern)
    await _audit(request).append(
        request_id=_request_id(request),
        tool_id=body.tool_id,
        action="permission_grant",
        outcome="created",
        permission_scopes=[body.scope.value],
        affected_resources=[body.resource_pattern],
    )
    return ApiResponse(request_id=str(_request_id(request)), data=_grant_data(grant))


@router.delete("/permissions/grants/{grant_id}")
async def revoke_grant(grant_id: UUID, request: Request) -> ApiResponse[dict[str, bool]]:
    revoked = await _permissions(request).revoke_grant(grant_id)
    if not revoked:
        raise HTTPException(status_code=404, detail="Grant was not found.")
    await _audit(request).append(
        request_id=_request_id(request),
        tool_id="permission.grant",
        action="permission_grant",
        outcome="revoked",
        result_summary=str(grant_id),
    )
    return ApiResponse(request_id=str(_request_id(request)), data={"revoked": True})


@router.get("/audit", response_model=ApiResponse[list[AuditData]])
async def list_audit_records(
    request: Request,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0, le=100_000),
) -> ApiResponse[list[AuditData]]:
    records = await _audit(request).list_records(limit=limit, offset=offset)
    return ApiResponse(
        request_id=str(_request_id(request)),
        data=[_audit_data(record) for record in records],
    )
