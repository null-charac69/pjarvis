"""Initial safe built-in tools for time, host health, workspaces, web, and Git."""

from __future__ import annotations

import asyncio
import ctypes
import os
import platform
import shutil
import subprocess
import webbrowser
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, cast
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AnyHttpUrl, Field

from app.core.settings import Settings
from app.providers.tool_integrations import ToolProviderError
from app.schemas.events import SystemMetricUpdated, SystemMetricUpdatedPayload
from app.services.productivity import ProductivityService
from app.tools.registry import ToolExecutionError
from app.tools.sdk import (
    BaseTool,
    PermissionScope,
    RiskLevel,
    ToolCategory,
    ToolContext,
    ToolHealth,
    ToolHealthStatus,
    ToolInput,
    ToolManifest,
    ToolOutput,
)
from app.tools.security import validate_approved_website
from app.tools.workspaces import WorkspaceAccess, WorkspaceAccessError


class EmptyInput(ToolInput):
    pass


class TimeInput(ToolInput):
    timezone: str = "UTC"
    timestamp: datetime | None = None


class TimeOutput(ToolOutput):
    timestamp: datetime
    timezone: str


class SystemHealthOutput(ToolOutput):
    operating_system: str
    architecture: str
    cpu_count: int
    memory_total_bytes: int | None
    memory_available_bytes: int | None
    disk_free_bytes: int


class WorkspaceListInput(ToolInput):
    pass


class WorkspaceSummary(ToolOutput):
    workspace_id: str
    display_name: str


class WorkspaceListOutput(ToolOutput):
    workspaces: list[WorkspaceSummary]


class WorkspaceFilesInput(ToolInput):
    workspace_id: str = Field(min_length=1, max_length=64)
    relative_path: str = Field(default=".", max_length=4096)
    max_depth: int = Field(default=0, ge=0, le=3)


class WorkspaceEntryOutput(ToolOutput):
    relative_path: str
    entry_type: str
    size_bytes: int | None


class WorkspaceFilesOutput(ToolOutput):
    entries: list[WorkspaceEntryOutput]


class WorkspaceReadInput(ToolInput):
    workspace_id: str = Field(min_length=1, max_length=64)
    relative_path: str = Field(min_length=1, max_length=4096)


class WorkspaceReadOutput(ToolOutput):
    relative_path: str
    contents: str


class WorkspaceWriteInput(ToolInput):
    workspace_id: str = Field(min_length=1, max_length=64)
    relative_path: str = Field(min_length=1, max_length=4096)
    contents: str = Field(max_length=65_536)


class WorkspaceWriteOutput(ToolOutput):
    relative_path: str
    bytes_written: int


class WorkspaceDeleteInput(ToolInput):
    workspace_id: str = Field(min_length=1, max_length=64)
    relative_path: str = Field(min_length=1, max_length=4096)


class WorkspaceDeleteOutput(ToolOutput):
    relative_path: str
    deleted: bool


class WorkspaceSearchInput(ToolInput):
    workspace_id: str = Field(min_length=1, max_length=64)
    query: str = Field(min_length=1, max_length=200)


class WorkspaceMatchOutput(ToolOutput):
    relative_path: str
    excerpt: str


class WorkspaceSearchOutput(ToolOutput):
    matches: list[WorkspaceMatchOutput]


class WebSearchInput(ToolInput):
    query: str = Field(min_length=1, max_length=300)


class SearchResult(ToolOutput):
    title: str
    url: str
    snippet: str
    citation: str


class WebSearchOutput(ToolOutput):
    query: str
    results: list[SearchResult]
    provider: str


class WeatherInput(ToolInput):
    location: str = Field(default="", max_length=160)


class WeatherOutput(ToolOutput):
    location: str
    timezone: str
    observed_at: str
    temperature: float
    temperature_unit: str
    apparent_temperature: float
    humidity_percent: int
    weather_code: int
    wind_speed: float
    wind_speed_unit: str
    provider: str
    citation: str


class WebFetchInput(ToolInput):
    url: str = Field(min_length=1, max_length=2048)


class WebFetchOutput(ToolOutput):
    url: str
    title: str
    text: str
    content_type: str
    citation: str
    fetched_at: str


class OpenWebsiteInput(ToolInput):
    url: str = Field(min_length=1, max_length=2048)


class OpenWebsiteOutput(ToolOutput):
    url: str
    opened: bool


class GitStatusInput(ToolInput):
    workspace_id: str = Field(min_length=1, max_length=64)


class GitStatusOutput(ToolOutput):
    workspace_id: str
    branch_and_changes: str


class GitReadOutput(ToolOutput):
    workspace_id: str
    output: str


class DesktopLaunchInput(ToolInput):
    application_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")


class DesktopLaunchOutput(ToolOutput):
    application_id: str
    process_id: int


class WorkspaceOpenInput(ToolInput):
    workspace_id: str = Field(min_length=1, max_length=64)
    relative_path: str = Field(default=".", max_length=4096)


class WorkspaceOpenOutput(ToolOutput):
    relative_path: str
    opened: bool


class SystemMetricsOutput(ToolOutput):
    sampled_at: datetime
    cpu_percent: float
    memory_total_bytes: int
    memory_available_bytes: int
    memory_percent: float
    disk_total_bytes: int
    disk_free_bytes: int
    disk_percent: float


class ReminderCreateInput(ToolInput):
    title: str = Field(min_length=1, max_length=200)
    due_at: datetime


class ReminderIdInput(ToolInput):
    reminder_id: UUID


class ReminderItemOutput(ToolOutput):
    reminder_id: UUID
    title: str
    due_at: datetime
    status: Literal["open", "completed"]


class ReminderListOutput(ToolOutput):
    reminders: list[ReminderItemOutput]


class ReminderActionOutput(ToolOutput):
    reminder: ReminderItemOutput


def _reminder_item(record: Any) -> ReminderItemOutput:
    return ReminderItemOutput(
        reminder_id=record.id,
        title=record.title,
        due_at=record.due_at,
        status=record.status,
    )


def _workspace_access(context: ToolContext) -> WorkspaceAccess:
    return cast(WorkspaceAccess, context.require_service("workspaces", WorkspaceAccess))


def _system_memory() -> tuple[int | None, int | None]:
    if os.name == "nt":

        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        memory = MemoryStatus()
        memory.dwLength = ctypes.sizeof(MemoryStatus)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory)):
            return int(memory.ullTotalPhys), int(memory.ullAvailPhys)
        return None, None

    if hasattr(os, "sysconf"):
        try:
            page_size = os.sysconf("SC_PAGE_SIZE")
            total_pages = os.sysconf("SC_PHYS_PAGES")
            available_pages = os.sysconf("SC_AVPHYS_PAGES")
            return int(page_size * total_pages), int(page_size * available_pages)
        except (OSError, ValueError):
            pass
    return None, None


class DateTimeTool(BaseTool[TimeInput, TimeOutput]):
    manifest = ToolManifest(
        tool_id="system.datetime",
        display_name="Date and time",
        description="Get the current date and time or convert a timestamp to a requested timezone.",
        category=ToolCategory.SYSTEM_MONITORING,
        risk_level=RiskLevel.READ_ONLY,
    )
    input_model = TimeInput
    output_model = TimeOutput

    async def execute(self, arguments: TimeInput, context: ToolContext) -> TimeOutput:
        if arguments.timezone in {"UTC", "Etc/UTC"}:
            if arguments.timestamp is not None:
                if arguments.timestamp.tzinfo is None:
                    raise ToolExecutionError("timezone_required")
                return TimeOutput(
                    timestamp=arguments.timestamp.astimezone(UTC), timezone=arguments.timezone
                )
            return TimeOutput(timestamp=datetime.now(UTC), timezone=arguments.timezone)
        try:
            timezone = ZoneInfo(arguments.timezone)
        except (ValueError, ZoneInfoNotFoundError) as exception:
            raise ToolExecutionError("invalid_timezone") from exception
        if arguments.timestamp is not None:
            if arguments.timestamp.tzinfo is None:
                raise ToolExecutionError("timezone_required")
            timestamp = arguments.timestamp.astimezone(timezone)
        else:
            timestamp = datetime.now(timezone)
        return TimeOutput(timestamp=timestamp, timezone=arguments.timezone)


class SystemHealthTool(BaseTool[EmptyInput, SystemHealthOutput]):
    manifest = ToolManifest(
        tool_id="system.health",
        display_name="System health",
        description="Read basic operating system, memory, CPU, and disk health metrics.",
        category=ToolCategory.SYSTEM_MONITORING,
        risk_level=RiskLevel.READ_ONLY,
        required_scopes=(PermissionScope.SYSTEM_HEALTH_READ,),
    )
    input_model = EmptyInput
    output_model = SystemHealthOutput

    async def execute(self, arguments: EmptyInput, context: ToolContext) -> SystemHealthOutput:
        memory_total, memory_available = _system_memory()
        disk = shutil.disk_usage(Path.home())
        return SystemHealthOutput(
            operating_system=platform.platform()[:160],
            architecture=platform.machine()[:64],
            cpu_count=os.cpu_count() or 1,
            memory_total_bytes=memory_total,
            memory_available_bytes=memory_available,
            disk_free_bytes=disk.free,
        )


class WorkspaceListTool(BaseTool[WorkspaceListInput, WorkspaceListOutput]):
    manifest = ToolManifest(
        tool_id="workspace.list",
        display_name="List approved workspaces",
        description="List only workspace roots explicitly approved in configuration.",
        category=ToolCategory.FILESYSTEM,
        risk_level=RiskLevel.READ_ONLY,
        required_scopes=(PermissionScope.FILESYSTEM_READ,),
    )
    input_model = WorkspaceListInput
    output_model = WorkspaceListOutput

    async def execute(
        self, arguments: WorkspaceListInput, context: ToolContext
    ) -> WorkspaceListOutput:
        return WorkspaceListOutput(
            workspaces=[
                WorkspaceSummary(workspace_id=item.workspace_id, display_name=item.display_name)
                for item in _workspace_access(context).list_workspaces()
            ]
        )


class WorkspaceFilesTool(BaseTool[WorkspaceFilesInput, WorkspaceFilesOutput]):
    manifest = ToolManifest(
        tool_id="workspace.files",
        display_name="List workspace files",
        description="List bounded entries under an approved workspace root.",
        category=ToolCategory.FILESYSTEM,
        risk_level=RiskLevel.READ_ONLY,
        required_scopes=(PermissionScope.FILESYSTEM_READ,),
    )
    input_model = WorkspaceFilesInput
    output_model = WorkspaceFilesOutput

    def affected_resources(self, arguments: WorkspaceFilesInput) -> tuple[str, ...]:
        return (f"{arguments.workspace_id}/{arguments.relative_path}",)

    async def execute(
        self, arguments: WorkspaceFilesInput, context: ToolContext
    ) -> WorkspaceFilesOutput:
        try:
            entries = _workspace_access(context).list_files(
                arguments.workspace_id,
                arguments.relative_path,
                max_depth=arguments.max_depth,
            )
        except WorkspaceAccessError as exception:
            raise ToolExecutionError(exception.code) from exception
        return WorkspaceFilesOutput(
            entries=[
                WorkspaceEntryOutput(
                    relative_path=entry.relative_path,
                    entry_type=entry.entry_type,
                    size_bytes=entry.size_bytes,
                )
                for entry in entries
            ]
        )


class WorkspaceReadTool(BaseTool[WorkspaceReadInput, WorkspaceReadOutput]):
    manifest = ToolManifest(
        tool_id="workspace.read",
        display_name="Read workspace text file",
        description="Read and redact a small text file under an approved workspace root.",
        category=ToolCategory.FILESYSTEM,
        risk_level=RiskLevel.READ_ONLY,
        required_scopes=(PermissionScope.FILESYSTEM_READ,),
    )
    input_model = WorkspaceReadInput
    output_model = WorkspaceReadOutput

    def affected_resources(self, arguments: WorkspaceReadInput) -> tuple[str, ...]:
        return (f"{arguments.workspace_id}/{arguments.relative_path}",)

    async def execute(
        self, arguments: WorkspaceReadInput, context: ToolContext
    ) -> WorkspaceReadOutput:
        try:
            contents = _workspace_access(context).read_text_file(
                arguments.workspace_id, arguments.relative_path, max_bytes=65_536
            )
        except WorkspaceAccessError as exception:
            raise ToolExecutionError(exception.code) from exception
        return WorkspaceReadOutput(relative_path=arguments.relative_path, contents=contents)


class WorkspaceWriteTool(BaseTool[WorkspaceWriteInput, WorkspaceWriteOutput]):
    manifest = ToolManifest(
        tool_id="workspace.write",
        display_name="Write workspace text file",
        description="Create or replace a bounded text file in an approved workspace.",
        category=ToolCategory.FILESYSTEM,
        risk_level=RiskLevel.MEDIUM,
        required_scopes=(PermissionScope.FILESYSTEM_WRITE,),
        requires_confirmation=True,
    )
    input_model = WorkspaceWriteInput
    output_model = WorkspaceWriteOutput

    def affected_resources(self, arguments: WorkspaceWriteInput) -> tuple[str, ...]:
        return (f"{arguments.workspace_id}/{arguments.relative_path}",)

    async def execute(
        self, arguments: WorkspaceWriteInput, context: ToolContext
    ) -> WorkspaceWriteOutput:
        try:
            size = _workspace_access(context).write_text_file(
                arguments.workspace_id,
                arguments.relative_path,
                arguments.contents,
                max_bytes=65_536,
            )
        except WorkspaceAccessError as exception:
            raise ToolExecutionError(exception.code) from exception
        return WorkspaceWriteOutput(relative_path=arguments.relative_path, bytes_written=size)


class WorkspaceDeleteTool(BaseTool[WorkspaceDeleteInput, WorkspaceDeleteOutput]):
    manifest = ToolManifest(
        tool_id="workspace.delete_file",
        display_name="Delete workspace file",
        description="Delete one file in an approved workspace; directories are never removed.",
        category=ToolCategory.FILESYSTEM,
        risk_level=RiskLevel.HIGH,
        required_scopes=(PermissionScope.FILESYSTEM_DELETE,),
        requires_confirmation=True,
    )
    input_model = WorkspaceDeleteInput
    output_model = WorkspaceDeleteOutput

    def affected_resources(self, arguments: WorkspaceDeleteInput) -> tuple[str, ...]:
        return (f"{arguments.workspace_id}/{arguments.relative_path}",)

    async def execute(
        self, arguments: WorkspaceDeleteInput, context: ToolContext
    ) -> WorkspaceDeleteOutput:
        try:
            _workspace_access(context).delete_file(arguments.workspace_id, arguments.relative_path)
        except WorkspaceAccessError as exception:
            raise ToolExecutionError(exception.code) from exception
        return WorkspaceDeleteOutput(relative_path=arguments.relative_path, deleted=True)


class WorkspaceSearchTool(BaseTool[WorkspaceSearchInput, WorkspaceSearchOutput]):
    manifest = ToolManifest(
        tool_id="workspace.search",
        display_name="Search workspace text",
        description=(
            "Search bounded text files in an approved workspace and return redacted excerpts."
        ),
        category=ToolCategory.FILESYSTEM,
        risk_level=RiskLevel.READ_ONLY,
        required_scopes=(PermissionScope.FILESYSTEM_READ,),
        max_output_bytes=65_536,
    )
    input_model = WorkspaceSearchInput
    output_model = WorkspaceSearchOutput

    def affected_resources(self, arguments: WorkspaceSearchInput) -> tuple[str, ...]:
        return (arguments.workspace_id,)

    async def execute(
        self, arguments: WorkspaceSearchInput, context: ToolContext
    ) -> WorkspaceSearchOutput:
        try:
            matches = _workspace_access(context).search_text(
                arguments.workspace_id, arguments.query
            )
        except WorkspaceAccessError as exception:
            raise ToolExecutionError(exception.code) from exception
        return WorkspaceSearchOutput(
            matches=[
                WorkspaceMatchOutput(relative_path=item.relative_path, excerpt=item.excerpt)
                for item in matches
            ]
        )


class WebSearchTool(BaseTool[WebSearchInput, WebSearchOutput]):
    manifest = ToolManifest(
        tool_id="web.search",
        display_name="Web search",
        description="Search the web using the configured search provider.",
        category=ToolCategory.WEB_INFORMATION,
        risk_level=RiskLevel.READ_ONLY,
        required_scopes=(PermissionScope.NETWORK_SEARCH,),
        max_output_bytes=65_536,
    )
    input_model = WebSearchInput
    output_model = WebSearchOutput

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings

    async def health_check(self) -> ToolHealth:
        provider = self._settings.providers.web_search if self._settings else "unconfigured"
        if provider == "unconfigured":
            return ToolHealth(
                status=ToolHealthStatus.UNCONFIGURED,
                message="No web search provider is configured.",
            )
        if provider == "brave" and (
            self._settings is None or self._settings.providers.web_search_api_key is None
        ):
            return ToolHealth(
                status=ToolHealthStatus.UNCONFIGURED,
                message="Brave Search requires an operator-configured API key.",
            )
        if provider == "mock":
            return ToolHealth(
                status=ToolHealthStatus.DEGRADED,
                message="Development mock search is selected; results are not live.",
            )
        return ToolHealth(status=ToolHealthStatus.HEALTHY, message="Brave Search is configured.")

    async def execute(self, arguments: WebSearchInput, context: ToolContext) -> WebSearchOutput:
        provider = context.services.get("web_search_provider", "unconfigured")
        if provider == "unconfigured":
            raise ToolExecutionError("provider_unconfigured")
        if provider == "mock":
            return WebSearchOutput(
                query=arguments.query,
                provider="mock",
                results=[
                    SearchResult(
                        title=f"Mock result for {arguments.query[:80]}",
                        url="https://example.invalid/",
                        snippet="This is a development-only mock search result.",
                        citation="mock://example.invalid/",
                    )
                ],
            )
        search = context.services.get("web_search")
        search_method = getattr(search, "search", None)
        if not callable(search_method):
            raise ToolExecutionError("provider_unconfigured")
        try:
            result = await search_method(arguments.query)
            return WebSearchOutput.model_validate(result)
        except ToolProviderError as exception:
            raise ToolExecutionError(exception.code) from exception
        except ToolExecutionError:
            raise
        except Exception as exception:
            raise ToolExecutionError("provider_failed") from exception


class WebWeatherTool(BaseTool[WeatherInput, WeatherOutput]):
    manifest = ToolManifest(
        tool_id="web.weather",
        display_name="Current weather",
        description="Look up current weather from Open-Meteo for a named location.",
        category=ToolCategory.WEB_INFORMATION,
        risk_level=RiskLevel.READ_ONLY,
        required_scopes=(PermissionScope.NETWORK_SEARCH,),
        max_output_bytes=16_384,
    )
    input_model = WeatherInput
    output_model = WeatherOutput

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings

    async def health_check(self) -> ToolHealth:
        if self._settings and self._settings.providers.weather == "unconfigured":
            return ToolHealth(
                status=ToolHealthStatus.UNCONFIGURED,
                message="Weather provider is not configured.",
            )
        return ToolHealth(
            status=ToolHealthStatus.HEALTHY,
            message="Open-Meteo weather is available.",
        )

    async def execute(self, arguments: WeatherInput, context: ToolContext) -> WeatherOutput:
        if self._settings and self._settings.providers.weather == "unconfigured":
            raise ToolExecutionError("provider_unconfigured")
        provider = context.services.get("weather")
        current = getattr(provider, "current", None)
        if not callable(current):
            raise ToolExecutionError("provider_unconfigured")
        try:
            return WeatherOutput.model_validate(await current(arguments.location))
        except ToolProviderError as exception:
            raise ToolExecutionError(exception.code) from exception
        except Exception as exception:
            raise ToolExecutionError("provider_failed") from exception


class WebFetchTool(BaseTool[WebFetchInput, WebFetchOutput]):
    manifest = ToolManifest(
        tool_id="web.fetch",
        display_name="Fetch approved webpage",
        description="Retrieve bounded HTML from an approved public HTTPS origin as untrusted text.",
        category=ToolCategory.WEB_INFORMATION,
        risk_level=RiskLevel.READ_ONLY,
        required_scopes=(PermissionScope.NETWORK_SEARCH,),
        timeout_seconds=12.0,
        max_output_bytes=65_536,
    )
    input_model = WebFetchInput
    output_model = WebFetchOutput

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings

    async def health_check(self) -> ToolHealth:
        if not self._settings or not self._settings.permissions.approved_website_origins:
            return ToolHealth(
                status=ToolHealthStatus.UNCONFIGURED,
                message="No approved fetch origins are configured.",
            )
        return ToolHealth(
            status=ToolHealthStatus.HEALTHY,
            message="Approved-origin fetch is available.",
        )

    def affected_resources(self, arguments: WebFetchInput) -> tuple[str, ...]:
        allowed = self._settings.permissions.approved_website_origins if self._settings else []
        try:
            return (validate_approved_website(arguments.url, allowed),)
        except ValueError as exception:
            raise ToolExecutionError("website_not_approved") from exception

    async def execute(self, arguments: WebFetchInput, context: ToolContext) -> WebFetchOutput:
        fetcher = context.services.get("web_fetch")
        fetch_method = getattr(fetcher, "fetch", None)
        if not callable(fetch_method):
            raise ToolExecutionError("provider_unconfigured")
        try:
            output = await fetch_method(arguments.url)
            return WebFetchOutput.model_validate(output)
        except ToolProviderError as exception:
            raise ToolExecutionError(exception.code) from exception
        except Exception as exception:
            raise ToolExecutionError("provider_failed") from exception


class SystemMetricsTool(BaseTool[EmptyInput, SystemMetricsOutput]):
    manifest = ToolManifest(
        tool_id="system.metrics",
        display_name="Host resource metrics",
        description="Read live CPU, memory, and disk utilization from the local host.",
        category=ToolCategory.SYSTEM_MONITORING,
        risk_level=RiskLevel.READ_ONLY,
        required_scopes=(PermissionScope.SYSTEM_HEALTH_READ,),
    )
    input_model = EmptyInput
    output_model = SystemMetricsOutput

    async def execute(self, arguments: EmptyInput, context: ToolContext) -> SystemMetricsOutput:
        monitor = context.services.get("system_monitor")
        sample = getattr(monitor, "sample", None)
        if not callable(sample):
            raise ToolExecutionError("provider_unconfigured")
        try:
            result = await asyncio.to_thread(sample)
            metrics = SystemMetricsOutput.model_validate(result)
            event_hub = context.services.get("event_hub")
            publish = getattr(event_hub, "publish", None)
            if callable(publish):
                for metric, value in (
                    ("cpu_percent", metrics.cpu_percent),
                    ("memory_percent", metrics.memory_percent),
                    ("disk_percent", metrics.disk_percent),
                ):
                    await publish(
                        SystemMetricUpdated(
                            type="system.metric.updated",
                            correlation_id=context.request_id,
                            payload=SystemMetricUpdatedPayload(
                                metric=metric, value=value, unit="percent"
                            ),
                        )
                    )
            return metrics
        except Exception as exception:
            raise ToolExecutionError("metrics_unavailable") from exception


class ReminderListTool(BaseTool[EmptyInput, ReminderListOutput]):
    manifest = ToolManifest(
        tool_id="productivity.reminders.list",
        display_name="List local reminders",
        description="List locally stored reminders and their completion status.",
        category=ToolCategory.PRODUCTIVITY,
        risk_level=RiskLevel.READ_ONLY,
        required_scopes=(PermissionScope.PRODUCTIVITY_READ,),
    )
    input_model = EmptyInput
    output_model = ReminderListOutput

    async def execute(self, arguments: EmptyInput, context: ToolContext) -> ReminderListOutput:
        service = context.require_service("productivity", ProductivityService)
        reminders = await service.list_reminders()
        return ReminderListOutput(reminders=[_reminder_item(item) for item in reminders])


class ReminderCreateTool(BaseTool[ReminderCreateInput, ReminderActionOutput]):
    manifest = ToolManifest(
        tool_id="productivity.reminders.create",
        display_name="Create local reminder",
        description="Store a local reminder with an explicit timezone-aware due time.",
        category=ToolCategory.PRODUCTIVITY,
        risk_level=RiskLevel.MEDIUM,
        required_scopes=(PermissionScope.PRODUCTIVITY_WRITE,),
        requires_confirmation=True,
    )
    input_model = ReminderCreateInput
    output_model = ReminderActionOutput

    def affected_resources(self, arguments: ReminderCreateInput) -> tuple[str, ...]:
        return ("local/reminders",)

    async def execute(
        self, arguments: ReminderCreateInput, context: ToolContext
    ) -> ReminderActionOutput:
        if arguments.due_at.tzinfo is None or arguments.due_at.utcoffset() is None:
            raise ToolExecutionError("timezone_required")
        service = context.require_service("productivity", ProductivityService)
        reminder = await service.create_reminder(arguments.title, arguments.due_at)
        return ReminderActionOutput(reminder=_reminder_item(reminder))


class ReminderCompleteTool(BaseTool[ReminderIdInput, ReminderActionOutput]):
    manifest = ToolManifest(
        tool_id="productivity.reminders.complete",
        display_name="Complete local reminder",
        description="Mark one locally stored reminder complete after confirmation.",
        category=ToolCategory.PRODUCTIVITY,
        risk_level=RiskLevel.MEDIUM,
        required_scopes=(PermissionScope.PRODUCTIVITY_WRITE,),
        requires_confirmation=True,
    )
    input_model = ReminderIdInput
    output_model = ReminderActionOutput

    def affected_resources(self, arguments: ReminderIdInput) -> tuple[str, ...]:
        return (f"local/reminders/{arguments.reminder_id}",)

    async def execute(
        self, arguments: ReminderIdInput, context: ToolContext
    ) -> ReminderActionOutput:
        service = context.require_service("productivity", ProductivityService)
        reminder = await service.complete_reminder(arguments.reminder_id)
        if reminder is None:
            raise ToolExecutionError("reminder_not_found")
        return ReminderActionOutput(reminder=_reminder_item(reminder))


class DesktopLaunchTool(BaseTool[DesktopLaunchInput, DesktopLaunchOutput]):
    manifest = ToolManifest(
        tool_id="desktop.launch_application",
        display_name="Launch approved application",
        description="Launch one operator-allowlisted executable without command-line arguments.",
        category=ToolCategory.DESKTOP_APPLICATIONS,
        risk_level=RiskLevel.MEDIUM,
        required_scopes=(PermissionScope.APPLICATION_LAUNCH,),
        requires_confirmation=True,
        timeout_seconds=10.0,
    )
    input_model = DesktopLaunchInput
    output_model = DesktopLaunchOutput

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings

    def _application_path(self, application_id: str) -> Path:
        applications = self._settings.permissions.approved_applications if self._settings else {}
        path = applications.get(application_id)
        if path is None or not path.is_absolute() or not path.is_file():
            raise ToolExecutionError("application_not_approved")
        return path.resolve(strict=True)

    def affected_resources(self, arguments: DesktopLaunchInput) -> tuple[str, ...]:
        return (str(self._application_path(arguments.application_id)),)

    async def health_check(self) -> ToolHealth:
        if os.name != "nt":
            return ToolHealth(
                status=ToolHealthStatus.UNAVAILABLE,
                message="Application launch is supported on Windows only.",
            )
        applications = (
            self._settings.permissions.approved_applications.values() if self._settings else ()
        )
        if not any(path.is_file() for path in applications):
            return ToolHealth(
                status=ToolHealthStatus.UNCONFIGURED,
                message="No applications are allowlisted.",
            )
        return ToolHealth(
            status=ToolHealthStatus.HEALTHY,
            message="Allowlisted application launch is available.",
        )

    async def execute(
        self, arguments: DesktopLaunchInput, context: ToolContext
    ) -> DesktopLaunchOutput:
        if os.name != "nt":
            raise ToolExecutionError("unsupported_platform")
        path = self._application_path(arguments.application_id)
        creationflags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0
        )
        try:
            process = await asyncio.create_subprocess_exec(
                str(path),
                cwd=str(path.parent),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                creationflags=creationflags,
            )
        except (OSError, ValueError) as exception:
            raise ToolExecutionError("application_launch_failed") from exception
        return DesktopLaunchOutput(
            application_id=arguments.application_id, process_id=process.pid or 0
        )


class WorkspaceOpenTool(BaseTool[WorkspaceOpenInput, WorkspaceOpenOutput]):
    manifest = ToolManifest(
        tool_id="desktop.open_workspace_folder",
        display_name="Open approved workspace folder",
        description="Open an existing folder only inside an approved workspace root.",
        category=ToolCategory.DESKTOP_APPLICATIONS,
        risk_level=RiskLevel.MEDIUM,
        required_scopes=(PermissionScope.APPLICATION_LAUNCH,),
        requires_confirmation=True,
    )
    input_model = WorkspaceOpenInput
    output_model = WorkspaceOpenOutput

    def affected_resources(self, arguments: WorkspaceOpenInput) -> tuple[str, ...]:
        return (f"{arguments.workspace_id}/{arguments.relative_path}",)

    async def execute(
        self, arguments: WorkspaceOpenInput, context: ToolContext
    ) -> WorkspaceOpenOutput:
        try:
            path = _workspace_access(context).resolve_path(
                arguments.workspace_id, arguments.relative_path
            )
        except WorkspaceAccessError as exception:
            raise ToolExecutionError(exception.code) from exception
        if not path.is_dir() or os.name != "nt":
            error = "unsupported_platform" if os.name != "nt" else "folder_required"
            raise ToolExecutionError(error)
        opener = context.services.get("folder_opener")
        if not callable(opener):
            opener = getattr(os, "startfile", None)
        if not callable(opener):
            raise ToolExecutionError("folder_opener_unavailable")
        try:
            await asyncio.to_thread(opener, str(path))
        except OSError as exception:
            raise ToolExecutionError("folder_open_failed") from exception
        return WorkspaceOpenOutput(relative_path=arguments.relative_path, opened=True)


class OpenWebsiteTool(BaseTool[OpenWebsiteInput, OpenWebsiteOutput]):
    manifest = ToolManifest(
        tool_id="web.open_website",
        display_name="Open approved website",
        description="Open a website only when its HTTPS origin is explicitly approved.",
        category=ToolCategory.WEB_INFORMATION,
        risk_level=RiskLevel.MEDIUM,
        required_scopes=(PermissionScope.BROWSER_OPEN,),
        requires_confirmation=True,
    )
    input_model = OpenWebsiteInput
    output_model = OpenWebsiteOutput

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings

    def _approved_origins(self) -> list[AnyHttpUrl]:
        if self._settings is None:
            return []
        return self._settings.permissions.approved_website_origins

    async def execute(self, arguments: OpenWebsiteInput, context: ToolContext) -> OpenWebsiteOutput:
        settings = context.require_service("settings", Settings)
        try:
            approved_url = validate_approved_website(
                arguments.url, settings.permissions.approved_website_origins
            )
        except ValueError as exception:
            raise ToolExecutionError("website_not_approved") from exception
        opener = context.services.get("website_opener", webbrowser.open)
        if not callable(opener):
            raise ToolExecutionError("browser_unavailable")
        try:
            opened = await asyncio.to_thread(opener, approved_url)
        except Exception as exception:
            raise ToolExecutionError("browser_unavailable") from exception
        return OpenWebsiteOutput(url=approved_url, opened=bool(opened))

    def affected_resources(self, arguments: OpenWebsiteInput) -> tuple[str, ...]:
        try:
            approved_url = validate_approved_website(arguments.url, self._approved_origins())
        except ValueError as exception:
            raise ToolExecutionError("website_not_approved") from exception
        return (approved_url,)


class GitStatusTool(BaseTool[GitStatusInput, GitStatusOutput]):
    manifest = ToolManifest(
        tool_id="development.git_status",
        display_name="Git status",
        description="Read Git status for an approved workspace using a fixed command.",
        category=ToolCategory.DEVELOPMENT,
        risk_level=RiskLevel.READ_ONLY,
        required_scopes=(PermissionScope.FILESYSTEM_READ,),
        timeout_seconds=5.0,
        max_output_bytes=16_384,
    )
    input_model = GitStatusInput
    output_model = GitStatusOutput

    def affected_resources(self, arguments: GitStatusInput) -> tuple[str, ...]:
        return (f"{arguments.workspace_id}/.git",)

    async def execute(self, arguments: GitStatusInput, context: ToolContext) -> GitStatusOutput:
        try:
            root = _workspace_access(context).get_workspace(arguments.workspace_id).root
        except WorkspaceAccessError as exception:
            raise ToolExecutionError(exception.code) from exception
        try:
            process = await asyncio.create_subprocess_exec(
                "git",
                "-C",
                str(root),
                "status",
                "--short",
                "--branch",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                cwd=root,
            )
            try:
                stdout, _ = await asyncio.wait_for(process.communicate(), timeout=4.0)
            except TimeoutError:
                process.kill()
                await process.wait()
                raise
        except TimeoutError as exception:
            raise ToolExecutionError("git_timed_out") from exception
        except (OSError, ValueError) as exception:
            raise ToolExecutionError("git_unavailable") from exception
        if process.returncode != 0:
            raise ToolExecutionError("not_a_git_repository")
        output = stdout.decode("utf-8", errors="replace")[:8192]
        return GitStatusOutput(
            workspace_id=arguments.workspace_id,
            branch_and_changes=output,
        )


class GitReadTool(BaseTool[GitStatusInput, GitReadOutput]):
    git_arguments: tuple[str, ...] = ()

    async def execute(self, arguments: GitStatusInput, context: ToolContext) -> GitReadOutput:
        try:
            root = _workspace_access(context).get_workspace(arguments.workspace_id).root
        except WorkspaceAccessError as exception:
            raise ToolExecutionError(exception.code) from exception
        try:
            process = await asyncio.create_subprocess_exec(
                "git",
                "-C",
                str(root),
                *self.git_arguments,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                cwd=root,
            )
            try:
                stdout, _ = await asyncio.wait_for(process.communicate(), timeout=4.0)
            except TimeoutError:
                process.kill()
                await process.wait()
                raise
        except TimeoutError as exception:
            raise ToolExecutionError("git_timed_out") from exception
        except (OSError, ValueError) as exception:
            raise ToolExecutionError("git_unavailable") from exception
        if process.returncode != 0:
            raise ToolExecutionError("not_a_git_repository")
        return GitReadOutput(
            workspace_id=arguments.workspace_id,
            output=stdout.decode("utf-8", errors="replace")[:8192],
        )

    def affected_resources(self, arguments: GitStatusInput) -> tuple[str, ...]:
        return (f"{arguments.workspace_id}/.git",)


class GitDiffTool(GitReadTool):
    manifest = ToolManifest(
        tool_id="development.git_diff",
        display_name="Git diff summary",
        description=(
            "Read a bounded diff summary without external diff or text-conversion commands."
        ),
        category=ToolCategory.DEVELOPMENT,
        risk_level=RiskLevel.READ_ONLY,
        required_scopes=(PermissionScope.FILESYSTEM_READ,),
        timeout_seconds=5.0,
        max_output_bytes=16_384,
    )
    input_model = GitStatusInput
    output_model = GitReadOutput
    git_arguments = ("--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--stat")


class GitLogTool(GitReadTool):
    manifest = ToolManifest(
        tool_id="development.git_log",
        display_name="Recent Git history",
        description="Read at most five local commits using a fixed Git command.",
        category=ToolCategory.DEVELOPMENT,
        risk_level=RiskLevel.READ_ONLY,
        required_scopes=(PermissionScope.FILESYSTEM_READ,),
        timeout_seconds=5.0,
        max_output_bytes=16_384,
    )
    input_model = GitStatusInput
    output_model = GitReadOutput
    git_arguments = ("--no-pager", "log", "-5", "--oneline", "--no-decorate")


def create_builtin_tools(settings: Settings | None = None) -> tuple[BaseTool[Any, Any], ...]:
    return (
        DateTimeTool(),
        SystemHealthTool(),
        SystemMetricsTool(),
        ReminderListTool(),
        ReminderCreateTool(),
        ReminderCompleteTool(),
        WorkspaceListTool(),
        WorkspaceFilesTool(),
        WorkspaceReadTool(),
        WorkspaceWriteTool(),
        WorkspaceDeleteTool(),
        WorkspaceSearchTool(),
        WebSearchTool(settings),
        WebWeatherTool(settings),
        WebFetchTool(settings),
        OpenWebsiteTool(settings),
        DesktopLaunchTool(settings),
        WorkspaceOpenTool(),
        GitStatusTool(),
        GitDiffTool(),
        GitLogTool(),
    )
