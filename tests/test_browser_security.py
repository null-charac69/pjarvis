import asyncio
import time
from collections.abc import Iterator

import httpx
import pytest
from app.core.browser_security import BrowserSessionStore
from app.core.settings import Settings
from app.main import create_app
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from starlette.websockets import WebSocketDisconnect

ORIGIN = "http://127.0.0.1:5173"


@pytest.fixture
def browser_client(tmp_path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("JARVIS_ENV", "test")
    settings = Settings(
        _env_file=None,
        app={"environment": "test", "developer_mode": False, "mock_when_unconfigured": True},
        deployment={"mode": "browser", "requests_per_minute": 60, "max_request_bytes": 1024},
        server={"host": "127.0.0.1", "allowed_origins": [ORIGIN]},
        database_url=SecretStr(f"sqlite+aiosqlite:///{(tmp_path / 'browser.sqlite3').as_posix()}"),
    )
    application: FastAPI = create_app(settings)
    with TestClient(application, client=("127.0.0.1", 50000)) as test_client:
        yield test_client


def _session_token(client: TestClient) -> str:
    response = client.post("/api/v1/session/token", headers={"Origin": ORIGIN})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert "expiresAt" in response.json()["data"]
    return response.json()["data"]["token"]


def test_browser_session_is_exact_origin_short_lived_and_not_persisted(
    browser_client: TestClient,
) -> None:
    token = _session_token(browser_client)
    sessions: BrowserSessionStore = browser_client.app.state.browser_sessions

    assert len(token) >= 40
    assert sessions._digest(token) in sessions._sessions
    assert token not in repr(sessions._sessions)
    response = browser_client.get(
        "/api/v1/health", headers={"Origin": ORIGIN, "X-Jarvis-Session-Token": token}
    )
    assert response.status_code == 200


def test_browser_session_store_expires_tokens() -> None:
    sessions = BrowserSessionStore(ttl_seconds=300)
    token, _ = sessions.issue()
    digest = sessions._digest(token)
    sessions._sessions[digest] = time.monotonic() - 1

    assert not sessions.is_valid(token)
    assert digest not in sessions._sessions


def test_browser_api_rejects_missing_session_and_unapproved_origin(
    browser_client: TestClient,
) -> None:
    missing_session = browser_client.get("/api/v1/health", headers={"Origin": ORIGIN})
    assert missing_session.status_code == 401
    assert missing_session.json()["error"]["code"] == "browser_session_required"

    denied_origin = browser_client.post(
        "/api/v1/session/token", headers={"Origin": "https://untrusted.example"}
    )
    assert denied_origin.status_code == 403

    token = _session_token(browser_client)
    denied_api_origin = browser_client.get(
        "/api/v1/health",
        headers={"Origin": "https://untrusted.example", "X-Jarvis-Session-Token": token},
    )
    assert denied_api_origin.status_code == 403
    assert denied_api_origin.json()["error"]["code"] == "origin_not_allowed"


def test_browser_same_origin_health_allows_valid_loopback_session_without_origin(
    browser_client: TestClient,
) -> None:
    token = _session_token(browser_client)
    response = browser_client.get(
        "/api/v1/health",
        headers={"Host": "127.0.0.1:8765", "X-Jarvis-Session-Token": token},
    )

    assert response.status_code == 200
    assert response.json()["data"]["status"] == "healthy"

    renderer_proxy_host = browser_client.get(
        "/api/v1/health",
        headers={"Host": "127.0.0.1:5173", "X-Jarvis-Session-Token": token},
    )
    assert renderer_proxy_host.status_code == 200

    provider_status = browser_client.get(
        "/api/v1/configuration/status",
        headers={"Host": "127.0.0.1:5173", "X-Jarvis-Session-Token": token},
    )
    assert provider_status.status_code == 200
    assert provider_status.json()["data"]["providers"]["llm"] == "mock"

    missing_session = browser_client.get(
        "/api/v1/configuration/status", headers={"Host": "127.0.0.1:5173"}
    )
    assert missing_session.status_code == 403
    assert missing_session.json()["error"]["code"] == "browser_session_required"


def test_browser_missing_origin_requires_session_and_approved_safe_route(
    browser_client: TestClient,
) -> None:
    token = _session_token(browser_client)
    headers = {"Host": "127.0.0.1:8765", "X-Jarvis-Session-Token": token}

    bootstrap_without_origin = browser_client.post("/api/v1/session/token")
    assert bootstrap_without_origin.status_code == 403

    missing_token = browser_client.get("/api/v1/health", headers={"Host": headers["Host"]})
    assert missing_token.status_code == 403
    assert missing_token.json()["error"]["code"] == "browser_session_required"

    unapproved_route = browser_client.get("/api/v1/not-a-safe-read", headers=headers)
    assert unapproved_route.status_code == 403
    assert unapproved_route.json()["error"]["code"] == "origin_required"

    state_change = browser_client.post("/api/v1/permissions/grants", headers=headers, json={})
    assert state_change.status_code == 403
    assert state_change.json()["error"]["code"] == "origin_required"


def test_browser_missing_origin_rejects_expired_and_other_profile_tokens(
    browser_client: TestClient,
) -> None:
    token = _session_token(browser_client)
    sessions: BrowserSessionStore = browser_client.app.state.browser_sessions
    sessions._sessions[sessions._digest(token)] = time.monotonic() - 1
    expired = browser_client.get(
        "/api/v1/health",
        headers={"Host": "127.0.0.1:8765", "X-Jarvis-Session-Token": token},
    )
    assert expired.status_code == 403
    assert expired.json()["error"]["code"] == "browser_session_required"

    other_profile = BrowserSessionStore(ttl_seconds=300)
    other_token, _ = other_profile.issue()
    cross_profile = browser_client.get(
        "/api/v1/health",
        headers={"Host": "127.0.0.1:8765", "X-Jarvis-Session-Token": other_token},
    )
    assert cross_profile.status_code == 403
    assert cross_profile.json()["error"]["code"] == "browser_session_required"


def test_browser_missing_origin_rejects_invalid_host_and_forwarded_headers(
    browser_client: TestClient,
) -> None:
    token = _session_token(browser_client)
    headers = {"X-Jarvis-Session-Token": token}
    invalid_host = browser_client.get(
        "/api/v1/health", headers={**headers, "Host": "attacker.example"}
    )
    assert invalid_host.status_code == 403
    assert invalid_host.json()["error"]["code"] == "host_not_allowed"

    for name, value in (
        ("X-Forwarded-For", "127.0.0.1"),
        ("X-Forwarded-Host", "127.0.0.1:8765"),
        ("Forwarded", "for=127.0.0.1;host=127.0.0.1:8765"),
    ):
        spoofed_request = browser_client.get(
            "/api/v1/health",
            headers={**headers, "Host": "127.0.0.1:8765", name: value},
        )
        assert spoofed_request.status_code == 403
        assert spoofed_request.json()["error"]["code"] == "forwarded_headers_not_allowed"


def test_browser_missing_origin_rejects_non_loopback_client(
    browser_client: TestClient,
) -> None:
    token = _session_token(browser_client)

    async def request_from_non_loopback() -> httpx.Response:
        transport = httpx.ASGITransport(
            app=browser_client.app,
            client=("192.0.2.20", 50001),
        )
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1:8765",
        ) as client:
            return await client.get(
                "/api/v1/health",
                headers={"Host": "127.0.0.1:8765", "X-Jarvis-Session-Token": token},
            )

    response = asyncio.run(request_from_non_loopback())
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "loopback_required"


def test_browser_api_rejects_oversized_body_before_route_dispatch(
    browser_client: TestClient,
) -> None:
    response = browser_client.post(
        "/api/v1/session/token",
        content=b"x" * 1025,
        headers={"Origin": ORIGIN},
    )

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "request_too_large"


def test_browser_websocket_authenticates_without_a_token_in_its_url(
    browser_client: TestClient,
) -> None:
    token = _session_token(browser_client)
    with browser_client.websocket_connect("/ws/events", headers={"origin": ORIGIN}) as websocket:
        websocket.send_json({"type": "authenticate", "token": token})
        websocket.send_json({"type": "ping"})
        assert websocket.receive_json() == {"type": "pong"}


def test_browser_websocket_rejects_invalid_session(browser_client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as disconnect:
        with browser_client.websocket_connect(
            "/ws/events", headers={"origin": ORIGIN}
        ) as websocket:
            websocket.send_json({"type": "authenticate", "token": "invalid"})
            websocket.receive_json()
    assert disconnect.value.code == 1008


def test_browser_websocket_rejects_invalid_origin(browser_client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect):
        with browser_client.websocket_connect(
            "/ws/events", headers={"origin": "https://untrusted.example"}
        ) as websocket:
            websocket.receive_json()


def test_electron_api_security_behavior_is_unchanged(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("JARVIS_ENV", "test")
    settings = Settings(
        _env_file=None,
        app={"environment": "test", "developer_mode": False, "mock_when_unconfigured": True},
        deployment={"mode": "electron"},
        server={"host": "127.0.0.1", "port": 8765, "allowed_origins": [ORIGIN]},
        database_url=SecretStr(f"sqlite+aiosqlite:///{(tmp_path / 'electron.sqlite3').as_posix()}"),
    )
    with TestClient(create_app(settings), client=("127.0.0.1", 50002)) as client:
        response = client.get("/api/v1/health")
    assert response.status_code == 200
