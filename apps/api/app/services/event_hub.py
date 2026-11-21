"""In-memory typed event fan-out for active WebSocket clients."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from app.schemas.events import EventContract


@dataclass
class EventClient:
    websocket: WebSocket
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class EventHub:
    def __init__(self, send_timeout_seconds: float = 2.0) -> None:
        self._clients: dict[int, EventClient] = {}
        self._clients_lock = asyncio.Lock()
        self._send_timeout_seconds = send_timeout_seconds

    @property
    def client_count(self) -> int:
        return len(self._clients)

    async def connect(self, websocket: WebSocket, *, accept: bool = True) -> None:
        if accept:
            await websocket.accept()
        async with self._clients_lock:
            self._clients[id(websocket)] = EventClient(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._clients_lock:
            self._clients.pop(id(websocket), None)

    async def publish(self, event: EventContract) -> None:
        payload = event.model_dump(mode="json", by_alias=True)
        async with self._clients_lock:
            clients = tuple(self._clients.values())
        await asyncio.gather(*(self._send(client, payload) for client in clients))

    async def _send(self, client: EventClient, payload: dict[str, object]) -> None:
        try:
            async with client.send_lock:
                await asyncio.wait_for(
                    client.websocket.send_json(payload),
                    timeout=self._send_timeout_seconds,
                )
        except (OSError, RuntimeError, TimeoutError, WebSocketDisconnect):
            await self.disconnect(client.websocket)
