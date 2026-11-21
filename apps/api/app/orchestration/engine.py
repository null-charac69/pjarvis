"""Deterministic, permission-gated command orchestration."""

from __future__ import annotations

import asyncio
import logging
import unicodedata
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, TypeVar
from uuid import UUID, uuid4

from pydantic import ValidationError

from app.core.settings import Settings
from app.models.audit import AuditRecord
from app.models.conversations import AssistantTaskRecord
from app.orchestration.models import (
    AssistantMessage,
    AssistantState,
    AuditRecordReference,
    ConfirmationRequest,
    ExecutionPlan,
    Intent,
    IntentKind,
    LLMPlanProposal,
    OrchestrationResult,
    PlanStep,
    SpeechPayload,
    TaskStatus,
    ToolResult,
    UserCommand,
)
from app.providers.llm import LLMProvider, ProviderError
from app.schemas.events import (
    AssistantPlanCreated,
    AssistantResponseCompleted,
    AssistantResponsePartial,
    AssistantStateChanged,
    AssistantStatePayload,
    CompletedResponsePayload,
    PartialResponsePayload,
    PlanCreatedPayload,
    TaskUpdated,
    TaskUpdatedPayload,
    ToolCompleted,
    ToolCompletedPayload,
    ToolFailed,
    ToolFailedPayload,
    ToolProgress,
    ToolProgressPayload,
    ToolStarted,
    ToolStartedPayload,
)
from app.schemas.events import (
    PlanStep as PlanEventStep,
)
from app.services.audit import AuditService
from app.services.conversations import ConversationNotFoundError, ConversationService
from app.services.event_hub import EventHub
from app.services.permissions import (
    ConfirmationChoice,
    ConfirmationTicket,
    PermissionService,
)
from app.services.permissions import (
    PermissionDecision as EnginePermissionDecision,
)
from app.tools.registry import (
    DisabledToolError,
    InvalidToolArgumentsError,
    ToolExecutionError,
    ToolRegistry,
    UnknownToolError,
)
from app.tools.sdk import BaseTool, ToolContext, ToolInput
from app.tools.security import mask_secrets

logger = logging.getLogger(__name__)
_ResultT = TypeVar("_ResultT")


class OrchestrationError(Exception):
    def __init__(self, error_code: str) -> None:
        super().__init__(error_code)
        self.error_code = error_code


@dataclass(frozen=True)
class _ValidatedStep:
    step: PlanStep
    tool: BaseTool[Any, Any]
    arguments: ToolInput
    resources: tuple[str, ...]


@dataclass
class _CommandRun:
    command_id: UUID
    task_id: UUID
    conversation_id: UUID
    command: UserCommand
    status: TaskStatus = TaskStatus.PENDING
    state: AssistantState = AssistantState.IDLE
    intent: Intent | None = None
    proposal: LLMPlanProposal | None = None
    plan: ExecutionPlan | None = None
    steps: list[_ValidatedStep] = field(default_factory=list)
    results: list[ToolResult] = field(default_factory=list)
    audit_records: list[AuditRecordReference] = field(default_factory=list)
    assistant_message: AssistantMessage | None = None
    speech_payload: SpeechPayload | None = None
    confirmation_request: ConfirmationRequest | None = None
    confirmation_step: int | None = None
    error_code: str | None = None
    deadline: float = 0
    worker: asyncio.Task[None] | None = None


class AssistantOrchestrator:
    def __init__(
        self,
        *,
        settings: Settings,
        provider: LLMProvider,
        registry: ToolRegistry,
        permissions: PermissionService,
        audit: AuditService,
        conversations: ConversationService,
        event_hub: EventHub,
        workspaces: Any,
        tool_integrations: dict[str, Any] | None = None,
    ) -> None:
        self._settings = settings
        self._provider = provider
        self._registry = registry
        self._permissions = permissions
        self._audit = audit
        self._conversations = conversations
        self._event_hub = event_hub
        self._workspaces = workspaces
        self._tool_integrations = tool_integrations or {}
        self._runs: dict[UUID, _CommandRun] = {}

    async def submit(self, command: UserCommand) -> OrchestrationResult:
        normalized_text = self._normalize_transcript(command.transcript)
        normalized_command = command.model_copy(update={"transcript": normalized_text})
        command_id = uuid4()
        task_id = uuid4()
        try:
            conversation_id, _ = await self._conversations.create_command(
                command_id=command_id,
                task_id=task_id,
                conversation_id=command.conversation_id,
                transcript=normalized_text,
            )
        except ConversationNotFoundError as exception:
            raise OrchestrationError("conversation_not_found") from exception
        normalized_command = normalized_command.model_copy(
            update={"conversation_id": conversation_id}
        )
        run = _CommandRun(
            command_id=command_id,
            task_id=task_id,
            conversation_id=conversation_id,
            command=normalized_command,
            deadline=(
                asyncio.get_running_loop().time()
                + self._settings.orchestration.command_timeout_seconds
            ),
        )
        self._runs[task_id] = run
        try:
            await self._append_audit(
                run,
                tool_id="assistant.orchestrator",
                action="assistant_command",
                outcome="accepted",
                arguments={"transcript": normalized_text},
            )
        except Exception as exception:
            await self._set_state(
                run,
                TaskStatus.FAILED,
                AssistantState.FAILED,
                error_code="audit_write_failed",
            )
            raise OrchestrationError("audit_write_failed") from exception
        await self._publish_task_update(run, "Command accepted.")
        run.worker = asyncio.create_task(self._run_initial(run))
        return self._snapshot(run)

    async def get_task(self, task_id: UUID) -> OrchestrationResult | None:
        run = self._runs.get(task_id)
        if run is not None:
            return self._snapshot(run)
        record = await self._conversations.get_task(task_id)
        return self._snapshot_record(record) if record is not None else None

    async def get_command(self, command_id: UUID) -> OrchestrationResult | None:
        run = next((item for item in self._runs.values() if item.command_id == command_id), None)
        if run is not None:
            return self._snapshot(run)
        record = await self._conversations.get_command(command_id)
        return self._snapshot_record(record) if record is not None else None

    async def resolve_confirmation(
        self, command_id: UUID, choice: ConfirmationChoice
    ) -> OrchestrationResult:
        run = next((item for item in self._runs.values() if item.command_id == command_id), None)
        if run is None or run.confirmation_request is None or run.confirmation_step is None:
            raise OrchestrationError("confirmation_not_found")
        confirmation_id = run.confirmation_request.confirmation_id

        async def record_resolution(ticket: ConfirmationTicket) -> None:
            await self._append_audit(
                run,
                tool_id=ticket.tool_id,
                action="assistant_permission_confirmation",
                outcome=choice.value,
                confirmation_id=confirmation_id,
                permission_scopes=[scope.value for scope in ticket.scopes],
                affected_resources=ticket.resources,
            )

        try:
            await self._permissions.resolve(
                confirmation_id,
                choice,
                run.command_id,
                before_resolve=record_resolution,
            )
        except ValueError as exception:
            raise OrchestrationError("confirmation_unavailable") from exception

        run.confirmation_request = None
        if choice == ConfirmationChoice.DENIED:
            step = run.steps[run.confirmation_step]
            run.results.append(
                ToolResult(
                    tool_call_id=uuid4(),
                    tool_id=step.tool.manifest.tool_id,
                    status="denied",
                    summary="The user denied this tool request.",
                    error_code="permission_denied",
                )
            )
            run.error_code = "permission_denied"
            await self._finish_message(
                run,
                "I did not proceed because permission was denied.",
                status=TaskStatus.CANCELLED,
                state=AssistantState.CANCELLED,
            )
            return self._snapshot(run)

        step_index = run.confirmation_step
        run.confirmation_step = None
        run.deadline = (
            asyncio.get_running_loop().time() + self._settings.orchestration.command_timeout_seconds
        )
        await self._set_state(run, TaskStatus.RUNNING, AssistantState.EXECUTING)
        run.worker = asyncio.create_task(self._resume_tools(run, step_index, confirmation_id))
        return self._snapshot(run)

    async def cancel_task(self, task_id: UUID) -> OrchestrationResult:
        run = self._runs.get(task_id)
        if run is None:
            result = await self.get_task(task_id)
            if result is None:
                raise OrchestrationError("task_not_found")
            return result
        if run.status in {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED}:
            return self._snapshot(run)

        if run.confirmation_request is not None:
            ticket = self._permissions.get_confirmation(run.confirmation_request.confirmation_id)
            if ticket is not None and ticket.decision is None:

                async def record_denial(confirmation: ConfirmationTicket) -> None:
                    await self._append_audit(
                        run,
                        tool_id=confirmation.tool_id,
                        action="assistant_permission_confirmation",
                        outcome=ConfirmationChoice.DENIED.value,
                        confirmation_id=confirmation.confirmation_id,
                        permission_scopes=[scope.value for scope in confirmation.scopes],
                        affected_resources=confirmation.resources,
                    )

                await self._permissions.resolve(
                    ticket.confirmation_id,
                    ConfirmationChoice.DENIED,
                    run.command_id,
                    before_resolve=record_denial,
                )
            run.confirmation_request = None

        worker = run.worker
        if worker is not None and not worker.done():
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)
        if run.status not in {TaskStatus.CANCELLED, TaskStatus.COMPLETED, TaskStatus.FAILED}:
            await self._mark_cancelled(run)
        return self._snapshot(run)

    async def history(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        conversation_id: UUID | None = None,
    ) -> list[OrchestrationResult]:
        records = await self._conversations.list_tasks(
            limit=limit, offset=offset, conversation_id=conversation_id
        )
        return [self._snapshot_record(record) for record in records]

    async def health_check(self) -> Any:
        return await self._provider.health_check()

    async def close(self) -> None:
        workers = [
            run.worker for run in self._runs.values() if run.worker and not run.worker.done()
        ]
        for worker in workers:
            worker.cancel()
        if workers:
            await asyncio.gather(*workers, return_exceptions=True)

    async def _run_initial(self, run: _CommandRun) -> None:
        try:
            await self._set_state(run, TaskStatus.RUNNING, AssistantState.TRANSCRIBING)
            await self._set_state(run, TaskStatus.RUNNING, AssistantState.THINKING)
            await self._set_state(run, TaskStatus.RUNNING, AssistantState.PLANNING)
            proposal = await self._with_provider_retries(
                lambda: self._provider.create_plan(run.command, self._available_tools()), run
            )
            run.proposal = proposal
            run.intent = proposal.intent
            run.steps = self._validate_proposal(proposal)
            run.plan = ExecutionPlan(steps=[step.step for step in run.steps])
            await self._append_audit(
                run,
                tool_id="assistant.orchestrator",
                action="assistant_plan",
                outcome=proposal.intent.kind.value,
                arguments={
                    "intent": proposal.intent.model_dump(mode="json"),
                    "plan": run.plan.model_dump(mode="json", by_alias=True),
                },
            )
            await self._persist(run)
            await self._event_hub.publish(
                AssistantPlanCreated(
                    type="assistant.plan.created",
                    correlation_id=run.command_id,
                    payload=PlanCreatedPayload(
                        plan_id=run.plan.plan_id,
                        steps=[
                            PlanEventStep(
                                step_id=step.step.step_id,
                                description=step.step.description,
                                tool_id=(
                                    step.tool.manifest.tool_id if step.step.tool_call else None
                                ),
                            )
                            for step in run.steps
                        ],
                    ),
                )
            )
            if proposal.intent.kind == IntentKind.CANCELLATION:
                await self._cancel_related(run)
                message = proposal.response_text or "Cancellation request processed."
                await self._finish_message(run, message)
            elif proposal.intent.kind in {IntentKind.DIRECT_RESPONSE, IntentKind.CLARIFICATION}:
                response = await self._with_provider_retries(
                    lambda: self._provider.create_response(run.command, proposal, []), run
                )
                await self._finish_message(run, response)
            elif proposal.intent.kind == IntentKind.UNSUPPORTED:
                message = proposal.response_text or "I can't safely perform that action."
                await self._finish_message(run, message)
            elif proposal.intent.kind == IntentKind.PROVIDER_UNAVAILABLE:
                await self._fail(run, "provider_unavailable", offline=True)
            elif not run.steps:
                raise OrchestrationError("invalid_plan")
            else:
                await self._execute_steps(run, 0, None)
        except asyncio.CancelledError:
            await self._mark_cancelled(run)
        except ProviderError as exception:
            await self._fail(
                run, exception.error_code, offline=exception.error_code == "provider_unconfigured"
            )
        except OrchestrationError as exception:
            await self._fail(run, exception.error_code)
        except Exception as exception:
            logger.error("Assistant orchestration failed type=%s", type(exception).__name__)
            await self._fail(run, "orchestration_failed")

    async def _resume_tools(self, run: _CommandRun, step_index: int, confirmation_id: UUID) -> None:
        try:
            await self._execute_steps(run, step_index, confirmation_id)
        except asyncio.CancelledError:
            await self._mark_cancelled(run)
        except ProviderError as exception:
            await self._fail(run, exception.error_code)
        except OrchestrationError as exception:
            await self._fail(run, exception.error_code)
        except Exception as exception:
            logger.error("Assistant orchestration failed type=%s", type(exception).__name__)
            await self._fail(run, "orchestration_failed")

    async def _execute_steps(
        self, run: _CommandRun, start_index: int, confirmation_id: UUID | None
    ) -> None:
        await self._set_state(run, TaskStatus.RUNNING, AssistantState.EXECUTING)
        for index in range(start_index, len(run.steps)):
            validated = run.steps[index]
            tool = validated.tool
            tool_id = tool.manifest.tool_id
            current_confirmation = confirmation_id if index == start_index else None
            permission = await self._permissions.evaluate(
                tool.manifest,
                validated.arguments.model_dump(mode="json"),
                validated.resources,
                run.command_id,
                current_confirmation,
            )
            await self._append_audit(
                run,
                tool_id=tool_id,
                action="assistant_permission",
                outcome=permission.decision.value,
                decision=permission.decision.value,
                confirmation_id=permission.confirmation_id,
                permission_scopes=[scope.value for scope in tool.manifest.required_scopes],
                affected_resources=validated.resources,
                arguments=validated.arguments.model_dump(mode="json"),
            )
            if permission.decision == EnginePermissionDecision.CONFIRMATION_REQUIRED:
                ticket = (
                    self._permissions.get_confirmation(permission.confirmation_id)
                    if permission.confirmation_id is not None
                    else None
                )
                if ticket is None:
                    raise OrchestrationError("confirmation_unavailable")
                run.confirmation_request = ConfirmationRequest(
                    confirmation_id=ticket.confirmation_id,
                    tool_id=ticket.tool_id,
                    risk_level=ticket.risk_level,
                    expires_at=ticket.expires_at,
                    scopes=[scope.value for scope in ticket.scopes],
                    masked_arguments=ticket.masked_arguments,
                    affected_resources=list(ticket.masked_resources),
                )
                run.confirmation_step = index
                await self._set_state(
                    run,
                    TaskStatus.AWAITING_CONFIRMATION,
                    AssistantState.AWAITING_CONFIRMATION,
                )
                return
            if permission.decision == EnginePermissionDecision.DENIED:
                run.results.append(
                    ToolResult(
                        tool_call_id=uuid4(),
                        tool_id=tool_id,
                        status="denied",
                        summary="Permission was denied by policy.",
                        error_code="permission_denied",
                    )
                )
                run.error_code = "permission_denied"
                await self._finish_message(
                    run,
                    "I don't have permission to perform that action.",
                    status=TaskStatus.FAILED,
                    state=AssistantState.FAILED,
                )
                return
            tool_call_id = uuid4()
            await self._append_audit(
                run,
                tool_id=tool_id,
                action="execute_intent",
                outcome="authorized",
                decision="approved",
                confirmation_id=permission.confirmation_id,
                permission_scopes=[scope.value for scope in tool.manifest.required_scopes],
                affected_resources=validated.resources,
                arguments=validated.arguments.model_dump(mode="json"),
                tool_call_id=tool_call_id,
            )
            await self._event_hub.publish(
                ToolStarted(
                    type="tool.started",
                    correlation_id=run.command_id,
                    payload=ToolStartedPayload(tool_call_id=tool_call_id, tool_id=tool_id),
                )
            )
            await self._event_hub.publish(
                ToolProgress(
                    type="tool.progress",
                    correlation_id=run.command_id,
                    payload=ToolProgressPayload(
                        tool_call_id=tool_call_id,
                        message=f"Executing planned step {index + 1} of {len(run.steps)}.",
                        progress=index / max(len(run.steps), 1),
                    ),
                )
            )
            started = datetime.now(UTC)
            context = ToolContext(
                request_id=run.command_id,
                services={
                    **self._tool_integrations,
                    "settings": self._settings,
                    "workspaces": self._workspaces,
                    "web_search_provider": self._settings.providers.web_search,
                },
            )
            try:
                output, _, _ = await asyncio.wait_for(
                    self._registry.execute(
                        tool_id,
                        validated.arguments.model_dump(mode="json"),
                        context,
                    ),
                    timeout=self._remaining_command_seconds(run),
                )
            except TimeoutError as exception:
                raise ToolExecutionError("command_timed_out") from exception
            except asyncio.CancelledError:
                elapsed = self._elapsed_ms(started)
                await self._terminal_tool_audit(
                    run,
                    validated,
                    tool_call_id,
                    outcome="cancelled",
                    error_code="tool_cancelled",
                    duration_ms=elapsed,
                )
                await self._publish_tool_failure(run, tool_call_id, "tool_cancelled")
                raise
            except (InvalidToolArgumentsError, ToolExecutionError) as exception:
                code = (
                    exception.error_code
                    if isinstance(exception, ToolExecutionError)
                    else "invalid_arguments"
                )
                status: Literal["failed", "timed_out", "unconfigured"] = (
                    "timed_out"
                    if code.endswith("timed_out")
                    else "unconfigured"
                    if code == "provider_unconfigured"
                    else "failed"
                )
                elapsed = self._elapsed_ms(started)
                result = ToolResult(
                    tool_call_id=tool_call_id,
                    tool_id=tool_id,
                    status=status,
                    summary="Tool execution did not complete.",
                    error_code=code,
                    duration_ms=elapsed,
                )
                run.results.append(result)
                await self._terminal_tool_audit(
                    run,
                    validated,
                    tool_call_id,
                    outcome=status,
                    error_code=code,
                    duration_ms=elapsed,
                )
                await self._publish_tool_failure(run, tool_call_id, code)
                run.error_code = code
                response_proposal = run.proposal
                if response_proposal is None:
                    if run.intent is None:
                        raise OrchestrationError("invalid_plan") from None
                    response_proposal = LLMPlanProposal(intent=run.intent)
                proposal_for_response: LLMPlanProposal = response_proposal

                async def create_failure_response(
                    proposal: LLMPlanProposal = proposal_for_response,
                ) -> str:
                    return await self._provider.create_response(run.command, proposal, run.results)

                response = await self._with_provider_retries(create_failure_response, run)
                await self._finish_message(
                    run,
                    response,
                    status=TaskStatus.FAILED,
                    state=AssistantState.FAILED,
                )
                return
            except Exception as exception:
                logger.error(
                    "Tool execution failed tool_id=%s type=%s", tool_id, type(exception).__name__
                )
                elapsed = self._elapsed_ms(started)
                result = ToolResult(
                    tool_call_id=tool_call_id,
                    tool_id=tool_id,
                    status="failed",
                    summary="Tool execution did not complete.",
                    error_code="tool_failed",
                    duration_ms=elapsed,
                )
                run.results.append(result)
                await self._terminal_tool_audit(
                    run,
                    validated,
                    tool_call_id,
                    outcome="failed",
                    error_code="tool_failed",
                    duration_ms=elapsed,
                )
                await self._publish_tool_failure(run, tool_call_id, "tool_failed")
                run.error_code = "tool_failed"
                await self._finish_message(
                    run,
                    "A requested tool could not complete.",
                    status=TaskStatus.FAILED,
                    state=AssistantState.FAILED,
                )
                return

            elapsed = self._elapsed_ms(started)
            safe_output = mask_secrets(output.model_dump(mode="json"))
            result = ToolResult(
                tool_call_id=tool_call_id,
                tool_id=tool_id,
                status="succeeded",
                summary=f"{tool_id} completed.",
                output=safe_output,
                duration_ms=elapsed,
                untrusted_content=tool.manifest.category.value
                in {"web_information", "filesystem", "development", "productivity"},
            )
            run.results.append(result)
            await self._terminal_tool_audit(
                run,
                validated,
                tool_call_id,
                outcome="succeeded",
                result_summary=result.summary,
                duration_ms=elapsed,
            )
            await self._persist(run)
            await self._event_hub.publish(
                ToolCompleted(
                    type="tool.completed",
                    correlation_id=run.command_id,
                    payload=ToolCompletedPayload(
                        tool_call_id=tool_call_id,
                        summary=result.summary,
                        duration_ms=elapsed,
                    ),
                )
            )

        proposal = run.proposal
        if proposal is None:
            raise OrchestrationError("invalid_plan")
        response = await self._with_provider_retries(
            lambda: self._provider.create_response(run.command, proposal, run.results), run
        )
        await self._finish_message(run, response)

    def _validate_proposal(self, proposal: LLMPlanProposal) -> list[_ValidatedStep]:
        if len(proposal.steps) > self._settings.orchestration.max_plan_steps:
            raise OrchestrationError("plan_step_limit_exceeded")
        tool_kinds = {IntentKind.SINGLE_TOOL, IntentKind.MULTI_TOOL}
        if proposal.intent.kind in tool_kinds:
            if not proposal.intent.requires_tools or not proposal.steps:
                raise OrchestrationError("invalid_plan")
            if proposal.intent.kind == IntentKind.SINGLE_TOOL and len(proposal.steps) != 1:
                raise OrchestrationError("invalid_plan")
            if proposal.intent.kind == IntentKind.MULTI_TOOL and len(proposal.steps) < 2:
                raise OrchestrationError("invalid_plan")
        elif proposal.intent.requires_tools or proposal.steps:
            raise OrchestrationError("invalid_plan")

        plan = ExecutionPlan(steps=proposal.steps)
        validated_steps: list[_ValidatedStep] = []
        for step in plan.steps:
            if step.tool_call is None:
                raise OrchestrationError("invalid_plan")
            try:
                tool = self._registry.get(step.tool_call.tool_id)
            except UnknownToolError as exception:
                raise OrchestrationError("unknown_tool") from exception
            except DisabledToolError as exception:
                raise OrchestrationError("tool_disabled") from exception
            try:
                arguments = tool.input_model.model_validate(step.tool_call.arguments)
            except ValidationError as exception:
                raise OrchestrationError("invalid_arguments") from exception
            try:
                resources = tuple(tool.affected_resources(arguments))
            except ToolExecutionError as exception:
                raise OrchestrationError(exception.error_code) from exception
            canonical_arguments = arguments.model_dump(mode="json")
            canonical_step = step.model_copy(
                update={
                    "tool_call": step.tool_call.model_copy(
                        update={"arguments": canonical_arguments}
                    )
                }
            )
            validated_steps.append(_ValidatedStep(canonical_step, tool, arguments, resources))
        return validated_steps

    async def _finish_message(
        self,
        run: _CommandRun,
        content: str,
        *,
        status: TaskStatus = TaskStatus.COMPLETED,
        state: AssistantState = AssistantState.COMPLETED,
    ) -> None:
        safe_content = str(mask_secrets(content.strip()))[:4000]
        if not safe_content:
            safe_content = "I couldn't form a response."
        run.assistant_message = AssistantMessage(role="assistant", content=safe_content)
        await self._conversations.add_assistant_message(
            conversation_id=run.conversation_id,
            command_id=run.command_id,
            task_id=run.task_id,
            content=safe_content,
        )
        tts_provider = self._settings.providers.tts
        tts_status: Literal["ready", "mock", "unconfigured"] = (
            "mock" if tts_provider == "mock" else "unconfigured"
        )
        run.speech_payload = SpeechPayload(
            text=safe_content,
            language=run.command.language or self._settings.voice.language,
            provider=tts_provider or "unconfigured",
            status=tts_status,
        )
        await self._set_state(run, TaskStatus.RUNNING, AssistantState.SPEAKING)
        await self._event_hub.publish(
            AssistantResponsePartial(
                type="assistant.response.partial",
                correlation_id=run.command_id,
                payload=PartialResponsePayload(text=safe_content, sequence=0),
            )
        )
        await self._append_audit(
            run,
            tool_id="assistant.orchestrator",
            action="assistant_response",
            outcome=status.value,
            result_summary=safe_content,
        )
        await self._event_hub.publish(
            AssistantResponseCompleted(
                type="assistant.response.completed",
                correlation_id=run.command_id,
                payload=CompletedResponsePayload(
                    message_id=run.assistant_message.message_id,
                    text=safe_content,
                ),
            )
        )
        await self._set_state(run, status, state)

    async def _fail(self, run: _CommandRun, error_code: str, *, offline: bool = False) -> None:
        run.error_code = error_code[:64]
        if run.intent is None:
            kind = IntentKind.PROVIDER_UNAVAILABLE if offline else IntentKind.UNSUPPORTED
            run.intent = Intent(kind=kind, summary="The command could not be processed.")
        message = (
            "The assistant provider is unavailable."
            if offline or error_code.startswith("provider_")
            else "I couldn't safely complete that command."
        )
        try:
            await self._append_audit(
                run,
                tool_id="assistant.orchestrator",
                action="assistant_command",
                outcome="failed",
                error_code=error_code,
            )
        except Exception:
            logger.error("Assistant failure audit could not be persisted error_code=%s", error_code)
        await self._finish_message(
            run,
            message,
            status=TaskStatus.FAILED,
            state=AssistantState.OFFLINE if offline else AssistantState.FAILED,
        )

    async def _mark_cancelled(self, run: _CommandRun) -> None:
        if run.status in {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED}:
            return
        run.error_code = "command_cancelled"
        try:
            await self._append_audit(
                run,
                tool_id="assistant.orchestrator",
                action="assistant_command",
                outcome="cancelled",
                error_code="command_cancelled",
            )
        except Exception:
            logger.error("Cancellation audit could not be persisted")
        run.assistant_message = AssistantMessage(
            role="assistant", content="The command was cancelled."
        )
        await self._conversations.add_assistant_message(
            conversation_id=run.conversation_id,
            command_id=run.command_id,
            task_id=run.task_id,
            content=run.assistant_message.content,
        )
        await self._set_state(run, TaskStatus.CANCELLED, AssistantState.CANCELLED)

    async def _cancel_related(self, run: _CommandRun) -> None:
        active = next(
            (
                candidate
                for candidate in self._runs.values()
                if candidate.task_id != run.task_id
                and candidate.conversation_id == run.conversation_id
                and candidate.status
                in {TaskStatus.PENDING, TaskStatus.RUNNING, TaskStatus.AWAITING_CONFIRMATION}
            ),
            None,
        )
        if active is not None:
            await self.cancel_task(active.task_id)

    async def _set_state(
        self,
        run: _CommandRun,
        status: TaskStatus,
        state: AssistantState,
        *,
        error_code: str | None = None,
    ) -> None:
        run.status = status
        run.state = state
        if error_code is not None:
            run.error_code = error_code
        await self._persist(run)
        await self._event_hub.publish(
            AssistantStateChanged(
                type="assistant.state.changed",
                correlation_id=run.command_id,
                payload=AssistantStatePayload(state=state.value),
            )
        )
        await self._publish_task_update(run)

    async def _publish_task_update(self, run: _CommandRun, detail: str | None = None) -> None:
        await self._event_hub.publish(
            TaskUpdated(
                type="task.updated",
                correlation_id=run.command_id,
                payload=TaskUpdatedPayload(task_id=run.task_id, status=run.status.value),
            )
        )

    async def _persist(self, run: _CommandRun) -> None:
        intent = run.intent.model_dump(mode="json", by_alias=True) if run.intent else None
        plan = run.plan.model_dump(mode="json", by_alias=True) if run.plan else None
        results = []
        for result in run.results:
            record = result.model_dump(mode="json", by_alias=True)
            record["output"] = None
            results.append(record)
        await self._conversations.update_task(
            run.task_id,
            status=run.status.value,
            assistant_state=run.state.value,
            intent=intent,
            plan=plan,
            tool_results=results,
            assistant_message=(run.assistant_message.content if run.assistant_message else None),
            confirmation_id=(
                run.confirmation_request.confirmation_id if run.confirmation_request else None
            ),
            error_code=run.error_code,
        )

    async def _append_audit(self, run: _CommandRun, **values: Any) -> AuditRecord:
        record = await self._audit.append(request_id=run.command_id, **values)
        run.audit_records.append(self._audit_reference(record))
        return record

    async def _terminal_tool_audit(
        self,
        run: _CommandRun,
        step: _ValidatedStep,
        tool_call_id: UUID,
        *,
        outcome: str,
        duration_ms: int,
        error_code: str | None = None,
        result_summary: str | None = None,
    ) -> None:
        await self._append_audit(
            run,
            tool_id=step.tool.manifest.tool_id,
            tool_call_id=tool_call_id,
            action="execute_result",
            outcome=outcome,
            decision="approved",
            permission_scopes=[scope.value for scope in step.tool.manifest.required_scopes],
            affected_resources=step.resources,
            arguments=step.arguments.model_dump(mode="json"),
            error_code=error_code,
            result_summary=result_summary,
            duration_ms=duration_ms,
        )

    async def _publish_tool_failure(
        self, run: _CommandRun, tool_call_id: UUID, error_code: str
    ) -> None:
        await self._event_hub.publish(
            ToolFailed(
                type="tool.failed",
                correlation_id=run.command_id,
                payload=ToolFailedPayload(tool_call_id=tool_call_id, error_code=error_code),
            )
        )

    async def _with_provider_retries(
        self, operation: Callable[[], Awaitable[_ResultT]], run: _CommandRun
    ) -> _ResultT:
        last_error: ProviderError | None = None
        for attempt in range(self._settings.orchestration.provider_max_retries + 1):
            remaining = self._remaining_command_seconds(run)
            command_deadline_limited = remaining <= self._settings.providers.llm_timeout_seconds
            try:
                return await asyncio.wait_for(
                    operation(),
                    timeout=min(remaining, self._settings.providers.llm_timeout_seconds),
                )
            except asyncio.CancelledError:
                raise
            except TimeoutError as exception:
                last_error = ProviderError(
                    "command_timed_out" if command_deadline_limited else "provider_timed_out"
                )
                last_error.__cause__ = exception
            except ProviderError as exception:
                last_error = exception
            except Exception as exception:
                last_error = ProviderError("provider_unavailable")
                last_error.__cause__ = exception
            if attempt < self._settings.orchestration.provider_max_retries:
                if last_error.error_code == "command_timed_out":
                    break
                logger.warning("LLM provider attempt failed error_code=%s", last_error.error_code)
        raise last_error or ProviderError("provider_unavailable")

    def _available_tools(self) -> list[dict[str, object]]:
        tools: list[dict[str, object]] = []
        for listing in self._registry.list_tools():
            if not listing.enabled:
                continue
            tools.append(
                {
                    "manifest": listing.manifest.model_dump(mode="json"),
                    "input_schema": listing.input_schema,
                }
            )
        return tools

    def _snapshot(self, run: _CommandRun) -> OrchestrationResult:
        return OrchestrationResult(
            command_id=run.command_id,
            task_id=run.task_id,
            conversation_id=run.conversation_id,
            status=run.status,
            state=run.state,
            intent=run.intent,
            plan=run.plan,
            tool_results=run.results,
            assistant_message=run.assistant_message,
            speech_payload=run.speech_payload,
            confirmation_request=run.confirmation_request,
            audit_records=run.audit_records,
            error_code=run.error_code,
        )

    def _snapshot_record(self, record: AssistantTaskRecord) -> OrchestrationResult:
        intent = Intent.model_validate(record.intent) if record.intent else None
        plan = ExecutionPlan.model_validate(record.plan) if record.plan else None
        results = [ToolResult.model_validate(item) for item in record.tool_results]
        message = (
            AssistantMessage(message_id=uuid4(), role="assistant", content=record.assistant_message)
            if record.assistant_message
            else None
        )
        tts_provider = self._settings.providers.tts or "unconfigured"
        speech_payload = (
            SpeechPayload(
                text=record.assistant_message,
                language=self._settings.voice.language,
                provider=tts_provider,
                status="mock" if tts_provider == "mock" else "unconfigured",
            )
            if record.assistant_message
            else None
        )
        confirmation = None
        if record.confirmation_id:
            ticket = self._permissions.get_confirmation(record.confirmation_id)
            if ticket is not None:
                confirmation = ConfirmationRequest(
                    confirmation_id=ticket.confirmation_id,
                    tool_id=ticket.tool_id,
                    risk_level=ticket.risk_level,
                    expires_at=ticket.expires_at,
                    scopes=[scope.value for scope in ticket.scopes],
                    masked_arguments=ticket.masked_arguments,
                    affected_resources=list(ticket.masked_resources),
                )
        return OrchestrationResult(
            command_id=record.command_id,
            task_id=record.id,
            conversation_id=record.conversation_id,
            status=TaskStatus(record.status),
            state=AssistantState(record.assistant_state),
            intent=intent,
            plan=plan,
            tool_results=results,
            assistant_message=message,
            speech_payload=speech_payload,
            confirmation_request=confirmation,
            error_code=record.error_code,
        )

    @staticmethod
    def _remaining_command_seconds(run: _CommandRun) -> float:
        remaining = run.deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise OrchestrationError("command_timed_out")
        return remaining

    async def _finish_from_record(self, record: AssistantTaskRecord) -> OrchestrationResult:
        return self._snapshot_record(record)

    @staticmethod
    def _audit_reference(record: AuditRecord) -> AuditRecordReference:
        return AuditRecordReference(
            record_id=record.id,
            action=record.action,
            outcome=record.outcome,
            occurred_at=record.occurred_at,
        )

    @staticmethod
    def _elapsed_ms(started_at: datetime) -> int:
        return max(0, int((datetime.now(UTC) - started_at).total_seconds() * 1000))

    @staticmethod
    def _normalize_transcript(transcript: str) -> str:
        normalized = unicodedata.normalize("NFKC", transcript)
        cleaned = " ".join(normalized.replace("\r", " ").replace("\n", " ").split())
        if not cleaned or any(
            unicodedata.category(character) == "Cc" and character not in "\t"
            for character in cleaned
        ):
            raise OrchestrationError("invalid_transcript")
        if len(cleaned) > 4000:
            raise OrchestrationError("transcript_too_long")
        return cleaned
