import pytest
from app.tools.builtin import create_builtin_tools
from app.tools.sdk import (
    PermissionScope,
    RiskLevel,
    ToolCategory,
    ToolInput,
    ToolManifest,
    ToolOutput,
)
from pydantic import ValidationError


def test_manifest_declares_stable_typed_policy() -> None:
    manifest = ToolManifest(
        tool_id="filesystem.read_text_file",
        display_name="Read approved text file",
        description="Read a bounded text file inside an approved workspace.",
        category=ToolCategory.FILESYSTEM,
        risk_level=RiskLevel.READ_ONLY,
        required_scopes=(PermissionScope.FILESYSTEM_READ,),
        timeout_seconds=3,
    )

    assert manifest.required_scopes == (PermissionScope.FILESYSTEM_READ,)
    assert manifest.manifest_version == 1


def test_manifest_rejects_unknown_permission_and_invalid_timeout() -> None:
    base = {
        "tool_id": "custom.test_tool",
        "display_name": "Test tool",
        "description": "Test manifest.",
        "category": "custom",
        "risk_level": "READ_ONLY",
    }

    with pytest.raises(ValidationError):
        ToolManifest(**base, required_scopes=("filesystem.unknown",))
    with pytest.raises(ValidationError):
        ToolManifest(**base, timeout_seconds=0)


def test_initial_tools_have_unique_complete_manifests_and_typed_schemas() -> None:
    tools = create_builtin_tools()
    tool_ids = [tool.manifest.tool_id for tool in tools]
    mutating_scopes = {
        PermissionScope.FILESYSTEM_WRITE,
        PermissionScope.FILESYSTEM_DELETE,
        PermissionScope.APPLICATION_LAUNCH,
        PermissionScope.SHELL_EXECUTE,
        PermissionScope.BROWSER_OPEN,
        PermissionScope.CLIPBOARD_WRITE,
        PermissionScope.EMAIL_DRAFT,
        PermissionScope.EMAIL_SEND,
        PermissionScope.CALENDAR_WRITE,
        PermissionScope.SYSTEM_CONTROL,
    }

    assert len(tool_ids) == len(set(tool_ids))
    for tool in tools:
        manifest = tool.manifest
        assert manifest.display_name.strip()
        assert manifest.description.strip()
        assert manifest.category
        assert manifest.risk_level
        assert manifest.timeout_seconds > 0
        assert isinstance(manifest.requires_confirmation, bool)
        assert issubclass(tool.input_model, ToolInput)
        assert issubclass(tool.output_model, ToolOutput)
        assert not (
            manifest.risk_level == RiskLevel.READ_ONLY
            and mutating_scopes & set(manifest.required_scopes)
        )
        assert tool.health_check is not None
        assert tool.execute is not None
