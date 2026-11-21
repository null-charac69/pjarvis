"""Local event WebSocket with an explicit health-only client protocol."""

import asyncio
import json

from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketDisconnect

from app.services.event_hub import EventHub

router = APIRouter()


@router.websocket("/ws/events")
async def event_stream(websocket: WebSocket) -> None:
    settings = websocket.app.state.settings
    origin = websocket.headers.get("origin")
    browser_mode = settings.deployment.mode in {"browser", "pwa"}
    if browser_mode and origin not in settings.server.allowed_origins:
        await websocket.close(code=1008)
        return
    if not browser_mode and origin is not None and origin not in settings.server.allowed_origins:
        await websocket.close(code=1008)
        return

    event_hub: EventHub = websocket.app.state.event_hub
    browser_token: str | None = None
    if browser_mode:
        await websocket.accept()
        try:
            raw_auth = await asyncio.wait_for(websocket.receive_text(), timeout=10)
            if len(raw_auth.encode("utf-8")) > 2048:
                await websocket.close(code=1009)
                return
            auth_message = json.loads(raw_auth)
            token = auth_message.get("token") if isinstance(auth_message, dict) else None
            if (
                not isinstance(auth_message, dict)
                or set(auth_message) != {"type", "token"}
                or auth_message.get("type") != "authenticate"
                or not websocket.app.state.browser_sessions.is_valid(token)
            ):
                await websocket.close(code=1008)
                return
            browser_token = token
        except (TimeoutError, json.JSONDecodeError, WebSocketDisconnect):
            await websocket.close(code=1008)
            return
        await event_hub.connect(websocket, accept=False)
    else:
        await event_hub.connect(websocket)
    try:
        while True:
            raw_message = await websocket.receive_text()
            if len(raw_message.encode("utf-8")) > 2048:
                await websocket.close(code=1009)
                break
            try:
                message = json.loads(raw_message)
            except json.JSONDecodeError:
                await websocket.close(code=1003)
                break
            if message != {"type": "ping"}:
                await websocket.close(code=1008)
                break
            if browser_mode and not websocket.app.state.browser_sessions.is_valid(browser_token):
                await websocket.close(code=1008)
                break
            await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        await event_hub.disconnect(websocket)
