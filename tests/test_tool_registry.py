import asyncio
from uuid import uuid4

import pytest
from app.tools.registry import (
    DisabledToolError,
    InvalidToolArgumentsError,
    ToolExecutionError,
    ToolRegistry,
    UnknownToolError,
)
from app.tools.sdk import (
    BaseTool,
    PermissionScope,
    RiskLevel,
    ToolCategory,
    ToolContext,
    ToolInput,
    ToolManifest,
    ToolOutput,
)
from pydantic import Field


class RegistryInput(ToolInput):
    value: str = Field(min_length=1, max_length=20)


class RegistryOutput(ToolOutput):
    value: str


class EchoTool(BaseTool[RegistryInput, RegistryOutput]):
    manifest = ToolManifest(
        tool_id="custom.echo",
        display_name="Echo",
        description="Return validated input.",
        category=ToolCategory.CUSTOM,
        risk_level=RiskLevel.READ_ONLY,
        max_output_bytes=1024,
    )
    input_model = RegistryInput
    output_model = RegistryOutput

    async def execute(self, arguments: RegistryInput, context: ToolContext) -> RegistryOutput:
        return RegistryOutput(value=arguments.value)


class SlowTool(EchoTool):
    manifest = ToolManifest(
        tool_id="custom.slow",
        display_name="Slow",
        description="Exceed the execution timeout.",
        category=ToolCategory.CUSTOM,
        risk_level=RiskLevel.READ_ONLY,
        timeout_seconds=0.01,
    )

    async def execute(self, arguments: RegistryInput, context: ToolContext) -> RegistryOutput:
        await asyncio.sleep(0.1)
        return RegistryOutput(value=arguments.value)


class LargeOutputTool(EchoTool):
    manifest = ToolManifest(
        tool_id="custom.large",
        display_name="Large output",
        description="Return a payload larger than its declared bound.",
        category=ToolCategory.CUSTOM,
        risk_level=RiskLevel.READ_ONLY,
        max_output_bytes=8,
    )

    async def execute(self, arguments: RegistryInput, context: ToolContext) -> RegistryOutput:
        return RegistryOutput(value="payload too large")


class FailingTool(EchoTool):
    manifest = ToolManifest(
        tool_id="custom.failing",
        display_name="Failing",
        description="Raise a tool execution exception.",
        category=ToolCategory.CUSTOM,
        risk_level=RiskLevel.READ_ONLY,
    )

    async def execute(self, arguments: RegistryInput, context: ToolContext) -> RegistryOutput:
        raise RuntimeError("private failure detail")


class ReadOnlyWriteTool(EchoTool):
    manifest = ToolManifest(
        tool_id="custom.readonly_write",
        display_name="Misclassified write",
        description="A read-only manifest with a filesystem write scope.",
        category=ToolCategory.CUSTOM,
        risk_level=RiskLevel.READ_ONLY,
        required_scopes=(PermissionScope.FILESYSTEM_WRITE,),
        requires_confirmation=True,
    )


class UnconfirmedHighRiskTool(EchoTool):
    manifest = ToolManifest(
        tool_id="custom.unconfirmed_high",
        display_name="Unconfirmed high risk",
        description="A high-risk tool without a confirmation requirement.",
        category=ToolCategory.CUSTOM,
        risk_level=RiskLevel.HIGH,
        required_scopes=(PermissionScope.FILESYSTEM_READ,),
    )


class UnconfirmedMutationTool(EchoTool):
    manifest = ToolManifest(
        tool_id="custom.unconfirmed_mutation",
        display_name="Unconfirmed mutation",
        description="A low-risk manifest with a filesystem delete scope.",
        category=ToolCategory.CUSTOM,
        risk_level=RiskLevel.LOW,
        required_scopes=(PermissionScope.FILESYSTEM_DELETE,),
    )


@pytest.mark.asyncio
async def test_registry_rejects_extra_arguments_and_bounds_outputs() -> None:
    registry = ToolRegistry((EchoTool(), LargeOutputTool()))
    context = ToolContext(request_id=uuid4())

    with pytest.raises(InvalidToolArgumentsError):
        await registry.execute("custom.echo", {"value": "ok", "shell": "no"}, context)
    with pytest.raises(ToolExecutionError, match="tool_output_too_large"):
        await registry.execute("custom.large", {"value": "ok"}, context)


@pytest.mark.asyncio
async def test_registry_enforces_manifest_timeout() -> None:
    registry = ToolRegistry((SlowTool(),))

    with pytest.raises(ToolExecutionError, match="tool_timed_out"):
        await registry.execute(
            "custom.slow",
            {"value": "wait"},
            ToolContext(request_id=uuid4()),
        )


def test_registry_rejects_duplicate_unknown_and_disabled_tools() -> None:
    registry = ToolRegistry((EchoTool(),))

    with pytest.raises(ValueError, match="Duplicate tool id"):
        registry.register(EchoTool())
    with pytest.raises(UnknownToolError):
        registry.get("custom.missing")

    registry.set_enabled("custom.echo", False)
    with pytest.raises(DisabledToolError):
        registry.get("custom.echo")


@pytest.mark.asyncio
async def test_registry_converts_tool_failure_to_safe_structured_error() -> None:
    registry = ToolRegistry((FailingTool(),))

    with pytest.raises(ToolExecutionError, match="tool_failed") as error:
        await registry.execute(
            "custom.failing",
            {"value": "run"},
            ToolContext(request_id=uuid4()),
        )

    assert error.value.error_code == "tool_failed"
    assert "private failure detail" not in str(error.value)


def test_registry_rejects_inconsistent_read_only_and_confirmation_policies() -> None:
    with pytest.raises(ValueError, match="read-only tool cannot request mutating scopes"):
        ToolRegistry((ReadOnlyWriteTool(),))
    with pytest.raises(ValueError, match="requires confirmation"):
        ToolRegistry((UnconfirmedHighRiskTool(),))
    with pytest.raises(ValueError, match="mutating scope requires confirmation"):
        ToolRegistry((UnconfirmedMutationTool(),))
