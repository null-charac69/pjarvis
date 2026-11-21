from uuid import uuid4

import pytest
from app.schemas.events import AssistantStateChanged
from app.services.event_hub import EventHub


class RecordingWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, object]] = []
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, payload: dict[str, object]) -> None:
        self.sent.append(payload)


@pytest.mark.asyncio
async def test_published_events_reach_connected_clients() -> None:
    hub = EventHub()
    websocket = RecordingWebSocket()
    event = AssistantStateChanged(
        type="assistant.state.changed",
        correlation_id=uuid4(),
        payload={"state": "Sleeping"},
    )

    await hub.connect(websocket)
    await hub.publish(event)

    assert websocket.accepted
    assert websocket.sent[0]["type"] == "assistant.state.changed"
    assert hub.client_count == 1
    await hub.disconnect(websocket)
    assert hub.client_count == 0


@pytest.mark.asyncio
async def test_unavailable_clients_are_removed() -> None:
    hub = EventHub()
    websocket = RecordingWebSocket()

    async def fail_send(payload: dict[str, object]) -> None:
        raise RuntimeError("disconnected")

    websocket.send_json = fail_send
    await hub.connect(websocket)
    await hub.publish(
        AssistantStateChanged(
            type="assistant.state.changed",
            correlation_id=uuid4(),
            payload={"state": "Offline"},
        )
    )

    assert hub.client_count == 0
