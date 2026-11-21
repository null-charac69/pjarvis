import asyncio
import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import pytest
from app.core.settings import Settings
from app.main import create_app
from app.tools.registry import ToolExecutionError
from app.tools.workspaces import WorkspaceAccess
from fastapi.testclient import TestClient
from pydantic import AnyHttpUrl, SecretStr


@pytest.fixture
def ask_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("JARVIS_ENV", "test")
    settings = Settings(
        _env_file=None,
        database_url=SecretStr(f"sqlite+aiosqlite:///{(tmp_path / 'ask.sqlite3').as_posix()}"),
    )
    settings.permissions.default_mode = "ask_every_time"
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def test_tools_are_discoverable_with_schemas_and_health(ask_client: TestClient) -> None:
    response = ask_client.get("/api/v1/tools")

    assert response.status_code == 200
    tools = {tool["manifest"]["tool_id"]: tool for tool in response.json()["data"]}
    assert {
        "system.datetime",
        "system.health",
        "workspace.list",
        "workspace.files",
        "workspace.read",
        "workspace.write",
        "workspace.delete_file",
        "workspace.search",
        "web.search",
        "web.weather",
        "web.fetch",
        "web.open_website",
        "system.metrics",
        "productivity.reminders.list",
        "productivity.reminders.create",
        "productivity.reminders.complete",
        "desktop.launch_application",
        "desktop.open_workspace_folder",
        "development.git_status",
        "development.git_diff",
        "development.git_log",
    } <= tools.keys()
    assert "properties" in tools["workspace.read"]["input_schema"]

    health = ask_client.get("/api/v1/tools/system.datetime/health")
    assert health.status_code == 200
    assert health.json()["data"]["status"] == "healthy"


def test_confirmation_is_bound_to_exact_arguments_and_workspace_resource(
    ask_client: TestClient, tmp_path: Path
) -> None:
    root = tmp_path / "approved"
    root.mkdir()
    (root / "notes.txt").write_text("api_key=private-value\nhello", encoding="utf-8")
    access = WorkspaceAccess([root])
    ask_client.app.state.workspaces = access
    workspace_id = access.list_workspaces()[0].workspace_id
    arguments = {"workspace_id": workspace_id, "relative_path": "notes.txt"}

    first = ask_client.post("/api/v1/tools/workspace.read/execute", json={"arguments": arguments})
    assert first.status_code == 200
    first_data = first.json()["data"]
    assert first_data["result"]["status"] == "confirmation_required"
    confirmation_id = first_data["confirmationId"]
    details = ask_client.get(f"/api/v1/permissions/confirmations/{confirmation_id}")
    assert details.status_code == 200
    assert details.json()["data"]["masked_arguments"] == arguments
    assert details.json()["data"]["affected_resources"] == [f"{workspace_id}/notes.txt"]

    resolution = ask_client.post(
        f"/api/v1/permissions/confirmations/{confirmation_id}",
        json={"decision": "approved_once"},
    )
    assert resolution.status_code == 200

    changed = ask_client.post(
        "/api/v1/tools/workspace.read/execute",
        json={
            "arguments": {"workspace_id": workspace_id, "relative_path": "other.txt"},
            "confirmation_id": confirmation_id,
        },
    )
    assert changed.json()["data"]["result"]["status"] == "denied"

    completed = ask_client.post(
        "/api/v1/tools/workspace.read/execute",
        json={"arguments": arguments, "confirmation_id": confirmation_id},
    )
    assert completed.status_code == 200
    result = completed.json()["data"]["result"]
    assert result["status"] == "succeeded"
    assert result["untrusted_content"] is True
    assert "private-value" not in str(result)
    assert "[REDACTED]" in result["data"]["output"]["contents"]

    audit = ask_client.get("/api/v1/audit?limit=20")
    assert audit.status_code == 200
    assert "private-value" not in audit.text
    assert any(record["action"] == "execute_intent" for record in audit.json()["data"])


def test_permission_grant_is_persistent_and_revocable(ask_client: TestClient) -> None:
    grant = ask_client.post(
        "/api/v1/permissions/grants",
        json={
            "tool_id": "system.health",
            "scope": "system.health.read",
            "resource_pattern": "*",
        },
    )
    assert grant.status_code == 201
    grant_id = grant.json()["data"]["id"]

    execution = ask_client.post("/api/v1/tools/system.health/execute", json={"arguments": {}})
    assert execution.status_code == 200
    assert execution.json()["data"]["result"]["status"] == "succeeded"

    listed = ask_client.get("/api/v1/permissions/grants")
    assert [item["id"] for item in listed.json()["data"]] == [grant_id]

    revoked = ask_client.delete(f"/api/v1/permissions/grants/{grant_id}")
    assert revoked.status_code == 200
    denied = ask_client.post("/api/v1/tools/system.health/execute", json={"arguments": {}})
    assert denied.json()["data"]["result"]["status"] == "confirmation_required"


def test_confirmation_binds_non_resource_arguments(ask_client: TestClient) -> None:
    first = ask_client.post(
        "/api/v1/tools/workspace.files/execute",
        json={
            "arguments": {
                "workspace_id": "test-workspace",
                "relative_path": ".",
                "max_depth": 0,
            }
        },
    )
    confirmation_id = first.json()["data"]["confirmationId"]
    ask_client.post(
        f"/api/v1/permissions/confirmations/{confirmation_id}",
        json={"decision": "approved_once"},
    )

    modified = ask_client.post(
        "/api/v1/tools/workspace.files/execute",
        json={
            "arguments": {
                "workspace_id": "test-workspace",
                "relative_path": ".",
                "max_depth": 1,
            },
            "confirmation_id": confirmation_id,
        },
    )
    assert modified.json()["data"]["result"]["status"] == "denied"


def test_session_approval_is_not_a_durable_grant(ask_client: TestClient, tmp_path: Path) -> None:
    root = tmp_path / "approved-session"
    root.mkdir()
    (root / "nested").mkdir()
    (root / "nested" / "readme.txt").write_text("session-only", encoding="utf-8")
    access = WorkspaceAccess([root])
    ask_client.app.state.workspaces = access
    workspace_id = access.list_workspaces()[0].workspace_id
    arguments = {"workspace_id": workspace_id, "relative_path": ".", "max_depth": 0}

    requested = ask_client.post(
        "/api/v1/tools/workspace.files/execute", json={"arguments": arguments}
    )
    confirmation_id = requested.json()["data"]["confirmationId"]
    approved = ask_client.post(
        f"/api/v1/permissions/confirmations/{confirmation_id}",
        json={"decision": "approved_session"},
    )
    assert approved.status_code == 200

    mismatched = ask_client.post(
        "/api/v1/tools/workspace.files/execute",
        json={
            "arguments": {**arguments, "max_depth": 1},
            "confirmation_id": confirmation_id,
        },
    )
    assert mismatched.json()["data"]["result"]["status"] == "denied"

    executed = ask_client.post(
        "/api/v1/tools/workspace.files/execute", json={"arguments": arguments}
    )
    assert executed.json()["data"]["result"]["status"] == "succeeded"
    assert ask_client.get("/api/v1/permissions/grants").json()["data"] == []


def test_expired_confirmation_cannot_be_read_or_resolved(ask_client: TestClient) -> None:
    requested = ask_client.post(
        "/api/v1/tools/workspace.files/execute",
        json={
            "arguments": {
                "workspace_id": "test-workspace",
                "relative_path": ".",
                "max_depth": 0,
            }
        },
    )
    confirmation_id = requested.json()["data"]["confirmationId"]
    ticket = ask_client.app.state.permission_service._tickets[UUID(confirmation_id)]
    ticket.expires_at = datetime.now(UTC) - timedelta(seconds=1)

    details = ask_client.get(f"/api/v1/permissions/confirmations/{confirmation_id}")
    assert details.status_code == 404
    resolved = ask_client.post(
        f"/api/v1/permissions/confirmations/{confirmation_id}",
        json={"decision": "approved_once"},
    )
    assert resolved.status_code == 404


def test_default_deny_does_not_issue_confirmation(client: TestClient) -> None:
    response = client.post("/api/v1/tools/system.health/execute", json={"arguments": {}})

    assert response.status_code == 200
    assert response.json()["data"]["result"]["status"] == "denied"
    assert response.json()["data"]["confirmationId"] is None
    audit = client.get("/api/v1/audit?limit=20").json()["data"]
    assert any(record["outcome"] == "denied" for record in audit)


def test_date_time_supports_utc_and_named_timezones(client: TestClient) -> None:
    utc_result = client.post(
        "/api/v1/tools/system.datetime/execute",
        json={"arguments": {"timezone": "UTC"}},
    )
    assert utc_result.json()["data"]["result"]["status"] == "succeeded"
    assert utc_result.json()["data"]["result"]["data"]["output"]["timezone"] == "UTC"

    named_result = client.post(
        "/api/v1/tools/system.datetime/execute",
        json={"arguments": {"timezone": "Asia/Kolkata"}},
    )
    assert named_result.json()["data"]["result"]["status"] == "succeeded"
    assert named_result.json()["data"]["result"]["data"]["output"]["timezone"] == "Asia/Kolkata"

    converted = client.post(
        "/api/v1/tools/system.datetime/execute",
        json={
            "arguments": {
                "timestamp": "2025-01-01T12:00:00+00:00",
                "timezone": "Asia/Kolkata",
            }
        },
    )
    assert converted.json()["data"]["result"]["data"]["output"]["timestamp"].startswith(
        "2025-01-01T17:30:00"
    )

    invalid_result = client.post(
        "/api/v1/tools/system.datetime/execute",
        json={"arguments": {"timezone": "Not/A-Timezone"}},
    )
    assert invalid_result.json()["data"]["result"]["error_code"] == "invalid_timezone"


def test_mock_and_unconfigured_search_modes(ask_client: TestClient) -> None:
    settings = ask_client.app.state.settings
    grant = ask_client.post(
        "/api/v1/permissions/grants",
        json={
            "tool_id": "web.search",
            "scope": "network.search",
            "resource_pattern": "*",
        },
    )
    assert grant.status_code == 201
    settings.providers.web_search = "unconfigured"
    health = ask_client.get("/api/v1/tools/web.search/health")
    assert health.json()["data"]["status"] == "unconfigured"
    unconfigured = ask_client.post(
        "/api/v1/tools/web.search/execute",
        json={"arguments": {"query": "local test"}},
    )
    assert unconfigured.json()["data"]["result"]["status"] == "unconfigured"

    settings.providers.web_search = "mock"
    mock_health = ask_client.get("/api/v1/tools/web.search/health")
    assert mock_health.json()["data"]["status"] == "degraded"
    mocked = ask_client.post(
        "/api/v1/tools/web.search/execute",
        json={"arguments": {"query": "local test"}},
    )
    result = mocked.json()["data"]["result"]
    assert result["status"] == "succeeded"
    assert result["untrusted_content"] is True
    assert result["data"]["output"]["provider"] == "mock"


def test_website_open_requires_approval_and_exact_confirmation(
    ask_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    ask_client.app.state.settings.permissions.approved_website_origins = [
        AnyHttpUrl("https://docs.example.com")
    ]
    opened: list[str] = []

    def fake_open(url: str) -> bool:
        opened.append(url)
        return True

    monkeypatch.setattr("app.tools.builtin.webbrowser.open", fake_open)
    grant = ask_client.post(
        "/api/v1/permissions/grants",
        json={
            "tool_id": "web.open_website",
            "scope": "browser.open",
            "resource_pattern": "https://docs.example.com/guide",
        },
    )
    assert grant.status_code == 201
    unapproved = ask_client.post(
        "/api/v1/tools/web.open_website/execute",
        json={"arguments": {"url": "https://evil.example/"}},
    )
    assert unapproved.json()["data"]["result"]["status"] == "denied"
    assert unapproved.json()["data"]["confirmationId"] is None

    url = "https://docs.example.com/guide"
    first = ask_client.post(
        "/api/v1/tools/web.open_website/execute", json={"arguments": {"url": url}}
    )
    confirmation_id = first.json()["data"]["confirmationId"]
    ask_client.post(
        f"/api/v1/permissions/confirmations/{confirmation_id}",
        json={"decision": "approved_once"},
    )

    changed = ask_client.post(
        "/api/v1/tools/web.open_website/execute",
        json={
            "arguments": {"url": "https://evil.example/"},
            "confirmation_id": confirmation_id,
        },
    )
    assert changed.json()["data"]["result"]["status"] == "denied"
    assert opened == []

    completed = ask_client.post(
        "/api/v1/tools/web.open_website/execute",
        json={"arguments": {"url": url}, "confirmation_id": confirmation_id},
    )
    assert completed.json()["data"]["result"]["status"] == "succeeded"
    assert opened == [url]


def test_unknown_disabled_and_invalid_tool_calls_fail_safely(ask_client: TestClient) -> None:
    unknown = ask_client.post("/api/v1/tools/not.registered/execute", json={"arguments": {}})
    assert unknown.status_code == 404

    disabled = ask_client.patch("/api/v1/tools/system.datetime/enabled", json={"enabled": False})
    assert disabled.status_code == 200
    blocked = ask_client.post(
        "/api/v1/tools/system.datetime/execute",
        json={"arguments": {"timezone": "UTC"}},
    )
    assert blocked.status_code == 409

    ask_client.patch("/api/v1/tools/system.datetime/enabled", json={"enabled": True})
    invalid = ask_client.post(
        "/api/v1/tools/system.datetime/execute",
        json={"arguments": {"timezone": "UTC", "extra": "forbidden"}},
    )
    assert invalid.status_code == 422
    assert "forbidden" not in invalid.text


def test_permission_and_tool_lifecycle_events_are_published(
    ask_client: TestClient, tmp_path: Path
) -> None:
    root = tmp_path / "event-approved"
    root.mkdir()
    (root / "readme.txt").write_text("hello", encoding="utf-8")
    access = WorkspaceAccess([root])
    ask_client.app.state.workspaces = access
    workspace_id = access.list_workspaces()[0].workspace_id
    arguments = {"workspace_id": workspace_id, "relative_path": "readme.txt"}

    with ask_client.websocket_connect("/ws/events") as websocket:
        requested = ask_client.post(
            "/api/v1/tools/workspace.read/execute", json={"arguments": arguments}
        )
        confirmation_id = requested.json()["data"]["confirmationId"]
        permission_requested = websocket.receive_json()
        assert permission_requested["type"] == "permission.requested"
        assert permission_requested["payload"]["confirmationId"] == confirmation_id

        resolved = ask_client.post(
            f"/api/v1/permissions/confirmations/{confirmation_id}",
            json={"decision": "approved_once"},
        )
        assert resolved.status_code == 200
        permission_resolved = websocket.receive_json()
        assert permission_resolved["type"] == "permission.resolved"
        assert permission_resolved["payload"]["decision"] == "approved_once"

        completed = ask_client.post(
            "/api/v1/tools/workspace.read/execute",
            json={"arguments": arguments, "confirmation_id": confirmation_id},
        )
        assert completed.json()["data"]["result"]["status"] == "succeeded"
        assert [websocket.receive_json()["type"] for _ in range(2)] == [
            "tool.started",
            "tool.completed",
        ]

    audit = ask_client.get("/api/v1/audit?limit=20").json()["data"]
    assert {record["outcome"] for record in audit} >= {
        "confirmation_required",
        "approved_once",
        "authorized",
        "succeeded",
    }


def test_workspace_write_and_delete_require_exact_confirmation(
    ask_client: TestClient, tmp_path: Path
) -> None:
    root = tmp_path / "approved-mutations"
    root.mkdir()
    (root / "remove.txt").write_text("temporary", encoding="utf-8")
    access = WorkspaceAccess([root])
    ask_client.app.state.workspaces = access
    workspace_id = access.list_workspaces()[0].workspace_id

    write_arguments = {
        "workspace_id": workspace_id,
        "relative_path": "notes.txt",
        "contents": "new note",
    }
    requested_write = ask_client.post(
        "/api/v1/tools/workspace.write/execute", json={"arguments": write_arguments}
    ).json()["data"]
    assert requested_write["result"]["status"] == "confirmation_required"
    confirmation_id = requested_write["confirmationId"]
    ask_client.post(
        f"/api/v1/permissions/confirmations/{confirmation_id}",
        json={"decision": "approved_once"},
    )
    written = ask_client.post(
        "/api/v1/tools/workspace.write/execute",
        json={"arguments": write_arguments, "confirmation_id": confirmation_id},
    ).json()["data"]["result"]
    assert written["status"] == "succeeded"
    assert (root / "notes.txt").read_text(encoding="utf-8") == "new note"

    delete_arguments = {"workspace_id": workspace_id, "relative_path": "remove.txt"}
    requested_delete = ask_client.post(
        "/api/v1/tools/workspace.delete_file/execute",
        json={"arguments": delete_arguments},
    ).json()["data"]
    assert requested_delete["result"]["status"] == "confirmation_required"
    delete_confirmation_id = requested_delete["confirmationId"]
    ask_client.post(
        f"/api/v1/permissions/confirmations/{delete_confirmation_id}",
        json={"decision": "approved_once"},
    )
    deleted = ask_client.post(
        "/api/v1/tools/workspace.delete_file/execute",
        json={"arguments": delete_arguments, "confirmation_id": delete_confirmation_id},
    ).json()["data"]["result"]
    assert deleted["status"] == "succeeded"
    assert not (root / "remove.txt").exists()


def test_weather_and_fetch_use_injected_providers_and_return_citations(
    ask_client: TestClient,
) -> None:
    class Weather:
        async def current(self, location: str) -> dict[str, object]:
            assert location == "Pune"
            return {
                "location": "Pune, India",
                "timezone": "Asia/Kolkata",
                "observed_at": "2025-01-01T12:00",
                "temperature": 25.0,
                "temperature_unit": "°C",
                "apparent_temperature": 26.0,
                "humidity_percent": 50,
                "weather_code": 1,
                "wind_speed": 8.0,
                "wind_speed_unit": "km/h",
                "provider": "open_meteo",
                "citation": "https://open-meteo.com/",
            }

    class Fetcher:
        async def fetch(self, url: str) -> dict[str, str]:
            return {
                "url": url,
                "title": "Guide",
                "text": "Untrusted page text",
                "content_type": "text/html",
                "citation": url,
                "fetched_at": "2025-01-01T12:00:00+00:00",
            }

    settings = ask_client.app.state.settings
    settings.permissions.approved_website_origins = [AnyHttpUrl("https://docs.example.com")]
    ask_client.app.state.tool_integrations["weather"] = Weather()
    ask_client.app.state.tool_integrations["web_fetch"] = Fetcher()
    for tool_id, scope in (("web.weather", "network.search"), ("web.fetch", "network.search")):
        granted = ask_client.post(
            "/api/v1/permissions/grants",
            json={"tool_id": tool_id, "scope": scope, "resource_pattern": "*"},
        )
        assert granted.status_code == 201

    weather = ask_client.post(
        "/api/v1/tools/web.weather/execute", json={"arguments": {"location": "Pune"}}
    ).json()["data"]["result"]
    assert weather["status"] == "succeeded"
    assert weather["data"]["output"]["citation"] == "https://open-meteo.com/"

    page_url = "https://docs.example.com/guide"
    fetched = ask_client.post(
        "/api/v1/tools/web.fetch/execute", json={"arguments": {"url": page_url}}
    ).json()["data"]["result"]
    assert fetched["status"] == "succeeded"
    assert fetched["untrusted_content"] is True
    assert fetched["data"]["output"]["citation"] == page_url


def test_system_metrics_returns_real_sample_from_host(client: TestClient) -> None:
    grant = client.post(
        "/api/v1/permissions/grants",
        json={
            "tool_id": "system.metrics",
            "scope": "system.health.read",
            "resource_pattern": "*",
        },
    )
    assert grant.status_code == 201

    with client.websocket_connect("/ws/events") as websocket:
        response = client.post("/api/v1/tools/system.metrics/execute", json={"arguments": {}})
        events = [websocket.receive_json() for _ in range(5)]

    result = response.json()["data"]["result"]
    assert result["status"] == "succeeded"
    metrics = result["data"]["output"]
    assert 0 <= metrics["cpu_percent"] <= 100
    assert metrics["memory_total_bytes"] > 0
    assert metrics["disk_total_bytes"] >= metrics["disk_free_bytes"]
    assert [event["type"] for event in events].count("system.metric.updated") == 3


@pytest.mark.skipif(os.name != "nt", reason="Application launch is Windows-only")
def test_application_launch_uses_only_the_approved_executable(
    ask_client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    executable = tmp_path / "approved-editor.exe"
    executable.write_bytes(b"test placeholder")
    settings = ask_client.app.state.settings
    settings.permissions.approved_applications = {"editor": executable}
    launched: list[tuple[tuple[str, ...], dict[str, object]]] = []

    class Process:
        pid = 1234

    async def fake_create_subprocess_exec(*args: str, **kwargs: object) -> Process:
        launched.append((args, kwargs))
        return Process()

    monkeypatch.setattr(
        "app.tools.builtin.asyncio.create_subprocess_exec", fake_create_subprocess_exec
    )
    not_allowed = ask_client.post(
        "/api/v1/tools/desktop.launch_application/execute",
        json={"arguments": {"application_id": "other"}},
    )
    assert not_allowed.json()["data"]["result"]["status"] == "denied"

    arguments = {"application_id": "editor"}
    requested = ask_client.post(
        "/api/v1/tools/desktop.launch_application/execute",
        json={"arguments": arguments},
    ).json()["data"]
    confirmation_id = requested["confirmationId"]
    ask_client.post(
        f"/api/v1/permissions/confirmations/{confirmation_id}",
        json={"decision": "approved_once"},
    )
    completed = ask_client.post(
        "/api/v1/tools/desktop.launch_application/execute",
        json={"arguments": arguments, "confirmation_id": confirmation_id},
    ).json()["data"]["result"]

    assert completed["status"] == "succeeded"
    assert launched[0][0] == (str(executable),)
    assert launched[0][1]["cwd"] == str(tmp_path)


def test_local_reminders_persist_and_mutations_require_confirmation(
    ask_client: TestClient,
) -> None:
    read_grant = ask_client.post(
        "/api/v1/permissions/grants",
        json={
            "tool_id": "productivity.reminders.list",
            "scope": "productivity.read",
            "resource_pattern": "*",
        },
    )
    assert read_grant.status_code == 201
    due_at = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    create_arguments = {"title": "Review local build", "due_at": due_at}

    requested = ask_client.post(
        "/api/v1/tools/productivity.reminders.create/execute",
        json={"arguments": create_arguments},
    ).json()["data"]
    assert requested["result"]["status"] == "confirmation_required"
    confirmation_id = requested["confirmationId"]
    ask_client.post(
        f"/api/v1/permissions/confirmations/{confirmation_id}",
        json={"decision": "approved_once"},
    )
    created = ask_client.post(
        "/api/v1/tools/productivity.reminders.create/execute",
        json={"arguments": create_arguments, "confirmation_id": confirmation_id},
    ).json()["data"]["result"]
    assert created["status"] == "succeeded"
    reminder = created["data"]["output"]["reminder"]
    assert reminder["title"] == "Review local build"
    assert reminder["status"] == "open"

    listed = ask_client.post(
        "/api/v1/tools/productivity.reminders.list/execute", json={"arguments": {}}
    ).json()["data"]["result"]
    assert listed["status"] == "succeeded"
    assert listed["data"]["output"]["reminders"][0]["reminder_id"] == reminder["reminder_id"]

    complete_arguments = {"reminder_id": reminder["reminder_id"]}
    complete_request = ask_client.post(
        "/api/v1/tools/productivity.reminders.complete/execute",
        json={"arguments": complete_arguments},
    ).json()["data"]
    complete_confirmation = complete_request["confirmationId"]
    ask_client.post(
        f"/api/v1/permissions/confirmations/{complete_confirmation}",
        json={"decision": "approved_once"},
    )
    completed = ask_client.post(
        "/api/v1/tools/productivity.reminders.complete/execute",
        json={
            "arguments": complete_arguments,
            "confirmation_id": complete_confirmation,
        },
    ).json()["data"]["result"]
    assert completed["status"] == "succeeded"
    assert completed["data"]["output"]["reminder"]["status"] == "completed"


def test_cancelled_tool_execution_is_audited_and_emits_failure(
    ask_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    grant = ask_client.post(
        "/api/v1/permissions/grants",
        json={
            "tool_id": "system.health",
            "scope": "system.health.read",
            "resource_pattern": "*",
        },
    )
    assert grant.status_code == 201

    async def cancel_execution(tool_id: str, arguments: dict[str, object], context: object) -> None:
        raise asyncio.CancelledError

    monkeypatch.setattr(ask_client.app.state.tool_registry, "execute", cancel_execution)
    with ask_client.websocket_connect("/ws/events") as websocket:
        with pytest.raises(RuntimeError, match="No response returned"):
            ask_client.post("/api/v1/tools/system.health/execute", json={"arguments": {}})

        assert websocket.receive_json()["type"] == "tool.started"
        failed = websocket.receive_json()
        assert failed["type"] == "tool.failed"
        assert failed["payload"]["errorCode"] == "tool_cancelled"

    audit = ask_client.get("/api/v1/audit?limit=20").json()["data"]
    cancellation = next(record for record in audit if record["error_code"] == "tool_cancelled")
    assert cancellation["outcome"] == "cancelled"


@pytest.mark.parametrize(
    ("error_code", "expected_outcome"),
    [("tool_failed", "failed"), ("tool_timed_out", "timed_out")],
)
def test_failed_and_timed_out_executions_are_audited_and_published(
    ask_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    error_code: str,
    expected_outcome: str,
) -> None:
    grant = ask_client.post(
        "/api/v1/permissions/grants",
        json={
            "tool_id": "system.health",
            "scope": "system.health.read",
            "resource_pattern": "*",
        },
    )
    assert grant.status_code == 201

    async def fail_execution(tool_id: str, arguments: dict[str, object], context: object) -> None:
        raise ToolExecutionError(error_code)

    monkeypatch.setattr(ask_client.app.state.tool_registry, "execute", fail_execution)
    with ask_client.websocket_connect("/ws/events") as websocket:
        response = ask_client.post("/api/v1/tools/system.health/execute", json={"arguments": {}})
        assert response.json()["data"]["result"]["status"] == expected_outcome
        assert websocket.receive_json()["type"] == "tool.started"
        failed = websocket.receive_json()
        assert failed["type"] == "tool.failed"
        assert failed["payload"]["errorCode"] == error_code

    audit = ask_client.get("/api/v1/audit?limit=20").json()["data"]
    record = next(item for item in audit if item["error_code"] == error_code)
    assert record["outcome"] == expected_outcome


def test_audit_intent_write_failure_prevents_tool_execution(
    ask_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    grant = ask_client.post(
        "/api/v1/permissions/grants",
        json={
            "tool_id": "system.health",
            "scope": "system.health.read",
            "resource_pattern": "*",
        },
    )
    assert grant.status_code == 201
    executed = False

    async def fail_audit(**kwargs: object) -> None:
        raise OSError("audit storage unavailable")

    async def execute_tool(tool_id: str, arguments: dict[str, object], context: object) -> None:
        nonlocal executed
        executed = True

    monkeypatch.setattr(ask_client.app.state.audit_service, "append", fail_audit)
    monkeypatch.setattr(ask_client.app.state.tool_registry, "execute", execute_tool)

    with pytest.raises(OSError, match="audit storage unavailable"):
        ask_client.post("/api/v1/tools/system.health/execute", json={"arguments": {}})

    assert executed is False


def test_confirmation_audit_write_failure_does_not_resolve_permission(
    ask_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    requested = ask_client.post(
        "/api/v1/tools/workspace.files/execute",
        json={
            "arguments": {
                "workspace_id": "test-workspace",
                "relative_path": ".",
                "max_depth": 0,
            }
        },
    )
    confirmation_id = requested.json()["data"]["confirmationId"]
    audit_service = ask_client.app.state.audit_service
    original_append = audit_service.append

    async def fail_resolution_audit(**kwargs: object) -> None:
        if kwargs.get("action") == "permission_confirmation":
            raise OSError("audit storage unavailable")
        await original_append(**kwargs)

    monkeypatch.setattr(audit_service, "append", fail_resolution_audit)
    with pytest.raises(OSError, match="audit storage unavailable"):
        ask_client.post(
            f"/api/v1/permissions/confirmations/{confirmation_id}",
            json={"decision": "approved_session"},
        )

    ticket = ask_client.app.state.permission_service.get_confirmation(UUID(confirmation_id))
    assert ticket is not None
    assert ticket.decision is None
    assert ask_client.app.state.permission_service._session_grants == set()

    monkeypatch.setattr(audit_service, "append", original_append)
    resolved = ask_client.post(
        f"/api/v1/permissions/confirmations/{confirmation_id}",
        json={"decision": "approved_session"},
    )
    assert resolved.status_code == 200


def test_terminal_audit_write_failure_emits_safe_failure_event(
    ask_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    grant = ask_client.post(
        "/api/v1/permissions/grants",
        json={
            "tool_id": "system.health",
            "scope": "system.health.read",
            "resource_pattern": "*",
        },
    )
    assert grant.status_code == 201
    audit_service = ask_client.app.state.audit_service
    original_append = audit_service.append

    async def fail_terminal_audit(**kwargs: object) -> None:
        if kwargs.get("action") == "execute_result":
            raise OSError("audit storage unavailable")
        await original_append(**kwargs)

    monkeypatch.setattr(audit_service, "append", fail_terminal_audit)
    with ask_client.websocket_connect("/ws/events") as websocket:
        with pytest.raises(OSError, match="audit storage unavailable"):
            ask_client.post("/api/v1/tools/system.health/execute", json={"arguments": {}})

        assert websocket.receive_json()["type"] == "tool.started"
        failed = websocket.receive_json()
        assert failed["type"] == "tool.failed"
        assert failed["payload"]["errorCode"] == "audit_write_failed"

    records = ask_client.get("/api/v1/audit?limit=20").json()["data"]
    assert any(record["action"] == "execute_intent" for record in records)
    assert not any(record["action"] == "execute_result" for record in records)
