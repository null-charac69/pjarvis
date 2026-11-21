"""Common asynchronous interface for structured assistant LLM providers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.orchestration.models import LLMPlanProposal, ToolResult, UserCommand


class ProviderError(Exception):
    """Safe provider failure exposing only a stable error code."""

    def __init__(self, error_code: str) -> None:
        super().__init__(error_code)
        self.error_code = error_code


class ProviderHealth(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["healthy", "degraded", "unavailable", "unconfigured"]
    message: str


class LLMProvider(ABC):
    @abstractmethod
    async def create_plan(
        self, command: UserCommand, available_tools: list[dict[str, object]]
    ) -> LLMPlanProposal:
        """Return structured intent and proposed tool calls, never executable code."""

    @abstractmethod
    async def create_response(
        self, command: UserCommand, proposal: LLMPlanProposal, results: list[ToolResult]
    ) -> str:
        """Summarize outcomes while treating every tool result as untrusted data."""

    @abstractmethod
    async def health_check(self) -> ProviderHealth:
        """Check provider availability without exposing credentials or response bodies."""


class UnconfiguredLLMProvider(LLMProvider):
    async def create_plan(
        self, command: UserCommand, available_tools: list[dict[str, object]]
    ) -> LLMPlanProposal:
        raise ProviderError("provider_unconfigured")

    async def create_response(
        self, command: UserCommand, proposal: LLMPlanProposal, results: list[ToolResult]
    ) -> str:
        raise ProviderError("provider_unconfigured")

    async def health_check(self) -> ProviderHealth:
        return ProviderHealth(status="unconfigured", message="No LLM provider is configured.")
