import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


def test_event_socket_accepts_health_ping(client: TestClient) -> None:
    with client.websocket_connect("/ws/events") as websocket:
        websocket.send_json({"type": "ping"})
        assert websocket.receive_json() == {"type": "pong"}


def test_event_socket_rejects_unconfigured_origin(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as disconnect:
        with client.websocket_connect(
            "/ws/events",
            headers={"origin": "https://untrusted.example"},
        ):
            pass

    assert disconnect.value.code == 1008


def test_event_socket_closes_on_invalid_json(client: TestClient) -> None:
    with client.websocket_connect("/ws/events") as websocket:
        websocket.send_text("{invalid-json")
        with pytest.raises(WebSocketDisconnect) as disconnect:
            websocket.receive_json()

    assert disconnect.value.code == 1003
