"""Stable typed contracts for backend tools and plugin implementations."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, ClassVar
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ToolCategory(StrEnum):
    WEB_INFORMATION = "web_information"
    DESKTOP_APPLICATIONS = "desktop_applications"
    FILESYSTEM = "filesystem"
    DEVELOPMENT = "development"
    PRODUCTIVITY = "productivity"
    SYSTEM_MONITORING = "system_monitoring"
    CUSTOM = "custom"


class RiskLevel(StrEnum):
    READ_ONLY = "READ_ONLY"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    BLOCKED = "BLOCKED"


class PermissionScope(StrEnum):
    MICROPHONE_LISTEN = "microphone.listen"
    FILESYSTEM_READ = "filesystem.read"
    FILESYSTEM_WRITE = "filesystem.write"
    FILESYSTEM_DELETE = "filesystem.delete"
    APPLICATION_LAUNCH = "application.launch"
    SHELL_EXECUTE = "shell.execute"
    BROWSER_OPEN = "browser.open"
    CLIPBOARD_READ = "clipboard.read"
    CLIPBOARD_WRITE = "clipboard.write"
    SCREENSHOT_CAPTURE = "screenshot.capture"
    EMAIL_READ = "email.read"
    EMAIL_DRAFT = "email.draft"
    EMAIL_SEND = "email.send"
    CALENDAR_READ = "calendar.read"
    CALENDAR_WRITE = "calendar.write"
    NETWORK_SEARCH = "network.search"
    PRODUCTIVITY_READ = "productivity.read"
    PRODUCTIVITY_WRITE = "productivity.write"
    SYSTEM_CONTROL = "system.control"
    SYSTEM_HEALTH_READ = "system.health.read"


class ToolStatus(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    DENIED = "denied"
    CONFIRMATION_REQUIRED = "confirmation_required"
    UNCONFIGURED = "unconfigured"
    TIMED_OUT = "timed_out"


class ToolHealthStatus(StrEnum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNAVAILABLE = "unavailable"
    UNCONFIGURED = "unconfigured"
    DISABLED = "disabled"


class ToolInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ToolOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ToolManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    manifest_version: int = Field(default=1, ge=1)
    tool_id: str = Field(pattern=r"^[a-z][a-z0-9_.-]{1,127}$")
    display_name: str = Field(min_length=1, max_length=80)
    description: str = Field(min_length=1, max_length=1000)
    category: ToolCategory
    risk_level: RiskLevel
    required_scopes: tuple[PermissionScope, ...] = ()
    timeout_seconds: float = Field(default=5.0, gt=0, le=120)
    requires_confirmation: bool = False
    max_output_bytes: int = Field(default=262_144, ge=1, le=8_388_608)
    tags: tuple[str, ...] = ()


class ToolResult[ToolOutputT: ToolOutput](BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: ToolStatus
    summary: str = Field(max_length=500)
    data: ToolOutputT | None = None
    error_code: str | None = None
    duration_ms: int = Field(default=0, ge=0)
    untrusted_content: bool = False
    request_id: UUID
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ToolHealth(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: ToolHealthStatus
    message: str = Field(max_length=240)


@dataclass(frozen=True)
class ToolContext:
    request_id: UUID
    services: dict[str, Any] = field(default_factory=dict)

    def require_service(self, key: str, expected_type: type[Any]) -> Any:
        service = self.services.get(key)
        if not isinstance(service, expected_type):
            raise RuntimeError("A required tool service is unavailable.")
        return service


class BaseTool[ToolInputT: ToolInput, ToolOutputT: ToolOutput](ABC):
    manifest: ClassVar[ToolManifest]
    input_model: ClassVar[type[ToolInput]]
    output_model: ClassVar[type[ToolOutput]]

    @abstractmethod
    async def execute(self, arguments: ToolInputT, context: ToolContext) -> ToolOutputT:
        """Execute validated arguments using only injected, bounded capabilities."""

    async def health_check(self) -> ToolHealth:
        return ToolHealth(status=ToolHealthStatus.HEALTHY, message="Tool is available.")

    def affected_resources(self, arguments: ToolInputT) -> tuple[str, ...]:
        return ()
