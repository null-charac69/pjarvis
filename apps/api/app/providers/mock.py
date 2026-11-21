"""Deterministic LLM substitute for tests and explicitly selected development use."""

from __future__ import annotations

import re
from collections import deque

from pydantic import ValidationError

from app.orchestration.models import (
    Intent,
    IntentKind,
    LLMPlanProposal,
    PlanStep,
    ToolCall,
    ToolResult,
    UserCommand,
)
from app.providers.llm import LLMProvider, ProviderError, ProviderHealth


class MockLLMProvider(LLMProvider):
    def __init__(
        self,
        proposals: list[object] | None = None,
        response_text: str | None = None,
    ) -> None:
        self._proposals = deque(proposals or [])
        self._response_text = response_text
        self.plan_calls = 0
        self.response_calls = 0

    async def create_plan(
        self, command: UserCommand, available_tools: list[dict[str, object]]
    ) -> LLMPlanProposal:
        self.plan_calls += 1
        if self._proposals:
            candidate = self._proposals.popleft()
            if isinstance(candidate, Exception):
                raise candidate
            try:
                return LLMPlanProposal.model_validate(candidate)
            except ValidationError as exception:
                raise ProviderError("invalid_structured_output") from exception
        return self._classify(command.transcript)

    async def create_response(
        self, command: UserCommand, proposal: LLMPlanProposal, results: list[ToolResult]
    ) -> str:
        self.response_calls += 1
        if self._response_text is not None:
            return self._response_text
        if proposal.intent.kind == IntentKind.DIRECT_RESPONSE:
            return proposal.response_text or "I can help with that."
        if proposal.intent.kind == IntentKind.CLARIFICATION:
            return proposal.response_text or "Could you clarify what you would like me to do?"
        if proposal.intent.kind == IntentKind.UNSUPPORTED:
            return proposal.response_text or "I can't safely perform that action."
        if proposal.intent.kind == IntentKind.CANCELLATION:
            return proposal.response_text or "There is no active task to cancel."
        completed = sum(result.status == "succeeded" for result in results)
        failed = len(results) - completed
        if failed:
            return f"{completed} tool step(s) completed; {failed} did not complete."
        return f"Completed {completed} tool step(s)."

    async def health_check(self) -> ProviderHealth:
        return ProviderHealth(status="healthy", message="Deterministic mock provider is ready.")

    @staticmethod
    def _classify(transcript: str) -> LLMPlanProposal:
        normalized = transcript.strip()
        lowered = normalized.casefold()
        if re.match(r"^(cancel|stop|never mind|nevermind)\b", lowered):
            return LLMPlanProposal(
                intent=Intent(
                    kind=IntentKind.CANCELLATION,
                    summary="Cancel the active command.",
                ),
                response_text="Cancellation requested.",
            )
        if re.search(r"\b(delete|send|install|shell|command prompt|run command)\b", lowered):
            return LLMPlanProposal(
                intent=Intent(
                    kind=IntentKind.UNSUPPORTED,
                    summary="The requested action is not supported by the safe tool set.",
                ),
                response_text="I can't safely perform that action with the available tools.",
            )
        if lowered in {"search", "search the web", "look something up"}:
            return LLMPlanProposal(
                intent=Intent(
                    kind=IntentKind.CLARIFICATION,
                    summary="The search query is missing.",
                ),
                response_text="What would you like me to search for?",
            )

        steps: list[PlanStep] = []
        if "time" in lowered or "date" in lowered:
            steps.append(
                PlanStep(
                    step_id="current-time",
                    description="Get the current UTC date and time.",
                    tool_call=ToolCall(
                        tool_id="system.datetime",
                        arguments={"timezone": "UTC"},
                    ),
                )
            )
        if "health" in lowered or "system status" in lowered:
            steps.append(
                PlanStep(
                    step_id="system-health",
                    description="Read current system health metrics.",
                    tool_call=ToolCall(tool_id="system.health"),
                )
            )
        if steps:
            kind = IntentKind.SINGLE_TOOL if len(steps) == 1 else IntentKind.MULTI_TOOL
            return LLMPlanProposal(
                intent=Intent(
                    kind=kind,
                    summary="Retrieve the requested system information.",
                    requires_tools=True,
                ),
                steps=steps,
            )

        search_match = re.search(r"\b(?:search|look up)(?: the web)? for\s+(.+)$", normalized, re.I)
        if search_match:
            query = search_match.group(1).strip()
            if not query:
                return LLMPlanProposal(
                    intent=Intent(
                        kind=IntentKind.CLARIFICATION,
                        summary="The search query is missing.",
                    )
                )
            return LLMPlanProposal(
                intent=Intent(
                    kind=IntentKind.SINGLE_TOOL,
                    summary="Search for the requested information.",
                    requires_tools=True,
                ),
                steps=[
                    PlanStep(
                        step_id="web-search",
                        description="Search the configured web provider.",
                        tool_call=ToolCall(
                            tool_id="web.search",
                            arguments={"query": query[:300]},
                        ),
                    )
                ],
            )
        return LLMPlanProposal(
            intent=Intent(
                kind=IntentKind.DIRECT_RESPONSE,
                summary="Respond conversationally without using tools.",
            ),
            response_text="I heard you. What would you like help with?",
        )
