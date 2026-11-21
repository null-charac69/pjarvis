"""Validated tool discovery, lifecycle, and bounded execution."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ValidationError

from app.tools.sdk import (
    BaseTool,
    PermissionScope,
    RiskLevel,
    ToolHealth,
    ToolHealthStatus,
    ToolInput,
    ToolManifest,
    ToolOutput,
)

_MUTATING_SCOPES = frozenset(
    {
        PermissionScope.FILESYSTEM_WRITE,
        PermissionScope.FILESYSTEM_DELETE,
        PermissionScope.APPLICATION_LAUNCH,
        PermissionScope.SHELL_EXECUTE,
        PermissionScope.BROWSER_OPEN,
        PermissionScope.CLIPBOARD_WRITE,
        PermissionScope.EMAIL_DRAFT,
        PermissionScope.EMAIL_SEND,
        PermissionScope.CALENDAR_WRITE,
        PermissionScope.PRODUCTIVITY_WRITE,
        PermissionScope.SYSTEM_CONTROL,
    }
)


class ToolRegistryError(Exception):
    """Base class for safe registry errors."""


class UnknownToolError(ToolRegistryError):
    pass


class DisabledToolError(ToolRegistryError):
    pass


class InvalidToolArgumentsError(ToolRegistryError):
    pass


class ToolExecutionError(ToolRegistryError):
    def __init__(self, error_code: str) -> None:
        super().__init__(error_code)
        self.error_code = error_code


@dataclass(frozen=True)
class RegisteredTool:
    tool: BaseTool[Any, Any]
    enabled: bool = True


@dataclass(frozen=True)
class ToolListing:
    manifest: ToolManifest
    enabled: bool
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]


class ToolRegistry:
    def __init__(self, tools: tuple[BaseTool[Any, Any], ...] = ()) -> None:
        self._tools: dict[str, RegisteredTool] = {}
        for tool in tools:
            self.register(tool)

    def register(self, tool: BaseTool[Any, Any]) -> None:
        manifest = tool.manifest
        if manifest.tool_id in self._tools:
            raise ValueError(f"Duplicate tool id: {manifest.tool_id}")
        if manifest.risk_level is RiskLevel.BLOCKED:
            raise ValueError("Blocked tools cannot be registered.")
        if manifest.risk_level is RiskLevel.READ_ONLY and _MUTATING_SCOPES.intersection(
            manifest.required_scopes
        ):
            raise ValueError("A read-only tool cannot request mutating scopes.")
        if manifest.risk_level is RiskLevel.HIGH and not manifest.requires_confirmation:
            raise ValueError("A high-risk tool requires confirmation.")
        if (
            _MUTATING_SCOPES.intersection(manifest.required_scopes)
            and not manifest.requires_confirmation
        ):
            raise ValueError("A mutating scope requires confirmation.")
        if not issubclass(tool.input_model, ToolInput) or not issubclass(
            tool.output_model, ToolOutput
        ):
            raise TypeError("Tool models must derive from ToolInput and ToolOutput.")
        self._tools[manifest.tool_id] = RegisteredTool(tool=tool)

    def list_tools(self) -> list[ToolListing]:
        result = []
        for tool_id in sorted(self._tools):
            entry = self._tools[tool_id]
            result.append(
                ToolListing(
                    manifest=entry.tool.manifest,
                    enabled=entry.enabled,
                    input_schema=entry.tool.input_model.model_json_schema(),
                    output_schema=entry.tool.output_model.model_json_schema(),
                )
            )
        return result

    def get(self, tool_id: str) -> BaseTool[Any, Any]:
        entry = self._tools.get(tool_id)
        if entry is None:
            raise UnknownToolError("unknown_tool")
        if not entry.enabled:
            raise DisabledToolError("tool_disabled")
        return entry.tool

    def set_enabled(self, tool_id: str, enabled: bool) -> bool:
        entry = self._tools.get(tool_id)
        if entry is None:
            raise UnknownToolError("unknown_tool")
        self._tools[tool_id] = RegisteredTool(tool=entry.tool, enabled=enabled)
        return enabled

    async def health(self, tool_id: str) -> ToolHealth:
        entry = self._tools.get(tool_id)
        if entry is None:
            raise UnknownToolError("unknown_tool")
        if not entry.enabled:
            return ToolHealth(status=ToolHealthStatus.DISABLED, message="Tool is disabled.")
        try:
            return await asyncio.wait_for(
                entry.tool.health_check(), timeout=entry.tool.manifest.timeout_seconds
            )
        except TimeoutError:
            return ToolHealth(
                status=ToolHealthStatus.UNAVAILABLE,
                message="Health check timed out.",
            )
        except Exception:
            return ToolHealth(
                status=ToolHealthStatus.UNAVAILABLE,
                message="Health check failed.",
            )

    async def execute(
        self,
        tool_id: str,
        arguments: dict[str, Any],
        context: Any,
    ) -> tuple[BaseModel, ToolInput, tuple[str, ...]]:
        tool = self.get(tool_id)
        try:
            validated_arguments = tool.input_model.model_validate(arguments)
        except ValidationError as exception:
            raise InvalidToolArgumentsError("invalid_arguments") from exception

        try:
            resources = tuple(tool.affected_resources(validated_arguments))
            output = await asyncio.wait_for(
                tool.execute(validated_arguments, context),
                timeout=tool.manifest.timeout_seconds,
            )
        except TimeoutError as exception:
            raise ToolExecutionError("tool_timed_out") from exception
        except ToolExecutionError:
            raise
        except Exception as exception:
            raise ToolExecutionError("tool_failed") from exception

        try:
            validated_output = tool.output_model.model_validate(output)
        except ValidationError as exception:
            raise ToolExecutionError("invalid_tool_output") from exception
        output_size = len(
            json.dumps(validated_output.model_dump(mode="json"), ensure_ascii=True).encode("utf-8")
        )
        if output_size > tool.manifest.max_output_bytes:
            raise ToolExecutionError("tool_output_too_large")
        return validated_output, validated_arguments, resources
