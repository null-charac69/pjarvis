"""Short-lived browser sessions and loopback API request guards."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import re
import secrets
import time
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

ASGIMessage = dict[str, Any]
ASGIReceive = Callable[[], Awaitable[ASGIMessage]]
ASGISend = Callable[[ASGIMessage], Awaitable[None]]

_SAFE_GET_PATHS = frozenset(
    {
        "/api/v1/health",
        "/api/v1/health/live",
        "/api/v1/health/ready",
        "/api/v1/assistant/providers/llm/health",
        "/api/v1/assistant/history",
        "/api/v1/voice/health",
        "/api/v1/tools",
        "/api/v1/configuration",
        "/api/v1/configuration/status",
        "/api/v1/permissions/grants",
        "/api/v1/audit",
    }
)
_SAFE_GET_PATH_PATTERNS = (
    re.compile(r"^/api/v1/tools/[A-Za-z0-9_.-]{1,128}/health$"),
    re.compile(r"^/api/v1/tasks/[0-9a-fA-F-]{36}$"),
    re.compile(r"^/api/v1/assistant/commands/[0-9a-fA-F-]{36}$"),
    re.compile(r"^/api/v1/permissions/confirmations/[0-9a-fA-F-]{36}$"),
)
_FORWARDED_HEADER_PREFIXES = (
    b"x-forwarded-",
    b"x-original-",
    b"x-rewrite-",
)
_FORWARDED_HEADER_NAMES = frozenset(
    {b"forwarded", b"via", b"x-real-ip", b"x-client-ip", b"true-client-ip"}
)


class BrowserSessionStore:
    def __init__(self, ttl_seconds: int, max_sessions: int = 32) -> None:
        self._ttl_seconds = ttl_seconds
        self._max_sessions = max_sessions
        self._sessions: dict[bytes, float] = {}

    def issue(self) -> tuple[str, datetime]:
        now = time.monotonic()
        self._remove_expired(now)
        if len(self._sessions) >= self._max_sessions:
            oldest = min(self._sessions, key=self._sessions.__getitem__)
            self._sessions.pop(oldest)
        token = secrets.token_urlsafe(32)
        expires_at = now + self._ttl_seconds
        self._sessions[self._digest(token)] = expires_at
        return token, datetime.now(UTC) + timedelta(seconds=self._ttl_seconds)

    def is_valid(self, token: str | None) -> bool:
        if not token or len(token) > 128:
            return False
        now = time.monotonic()
        self._remove_expired(now)
        candidate = self._digest(token)
        return any(hmac.compare_digest(candidate, stored) for stored in self._sessions)

    @staticmethod
    def _digest(token: str) -> bytes:
        return hashlib.sha256(token.encode("utf-8")).digest()

    def _remove_expired(self, now: float) -> None:
        self._sessions = {
            digest: expiry for digest, expiry in self._sessions.items() if expiry > now
        }


class BrowserSecurityMiddleware:
    def __init__(
        self,
        app: Callable[..., Awaitable[None]],
        *,
        enabled: bool,
        allowed_origins: list[str],
        sessions: BrowserSessionStore,
        requests_per_minute: int,
        max_request_bytes: int,
        backend_host: str = "127.0.0.1",
        backend_port: int = 8765,
    ) -> None:
        self.app = app
        self.enabled = enabled
        self.allowed_origins = frozenset(allowed_origins)
        self.sessions = sessions
        self.requests_per_minute = requests_per_minute
        self.max_request_bytes = max_request_bytes
        self.allowed_hosts = {
            parsed.netloc.casefold()
            for origin in allowed_origins
            if (parsed := urlsplit(origin)).scheme in {"http", "https"} and parsed.netloc
        }
        normalized_backend_host = backend_host.strip("[]").casefold()
        backend_authority = (
            f"[{normalized_backend_host}]:{backend_port}"
            if ":" in normalized_backend_host
            else f"{normalized_backend_host}:{backend_port}"
        )
        self.allowed_hosts.add(backend_authority)
        self._request_times: dict[str, deque[float]] = defaultdict(deque)

    async def __call__(
        self,
        scope: dict[str, Any],
        receive: ASGIReceive,
        send: ASGISend,
    ) -> None:
        if not self.enabled or scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if not path.startswith("/api/v1/"):
            await self.app(scope, receive, send)
            return

        header_values: dict[bytes, list[bytes]] = defaultdict(list)
        for key, value in scope.get("headers", []):
            header_values[key.lower()].append(value)
        headers = {key: values[-1] for key, values in header_values.items()}
        origin_values = header_values.get(b"origin", [])
        origin_present = bool(origin_values)
        origin = origin_values[0].decode("latin-1") if len(origin_values) == 1 else None
        if len(origin_values) > 1:
            await self._reject(
                send, 403, "origin_not_allowed", "This browser origin is not allowed."
            )
            return

        if any(
            name in _FORWARDED_HEADER_NAMES
            or any(name.startswith(prefix) for prefix in _FORWARDED_HEADER_PREFIXES)
            for name in header_values
        ):
            await self._reject(
                send,
                403,
                "forwarded_headers_not_allowed",
                "Forwarded request headers are not trusted in browser mode.",
            )
            return

        method = scope.get("method", "").upper()
        bootstrap_path = path == "/api/v1/session/token" and method == "POST"
        liveness_path = path == "/api/v1/health/live" and method == "GET"
        if origin_present:
            if origin not in self.allowed_origins:
                await self._reject(
                    send, 403, "origin_not_allowed", "This browser origin is not allowed."
                )
                return
        else:
            if method != "GET" or not self._is_safe_get_path(path):
                await self._reject(
                    send, 403, "origin_required", "This request requires an allowed Origin."
                )
                return
            client = scope.get("client")
            if not self._is_loopback_client(client):
                await self._reject(
                    send, 403, "loopback_required", "This browser request must come from loopback."
                )
                return
            host_values = header_values.get(b"host", [])
            host = host_values[0].decode("latin-1").casefold() if len(host_values) == 1 else ""
            if not host or host not in self.allowed_hosts:
                await self._reject(
                    send, 403, "host_not_allowed", "This browser request host is not allowed."
                )
                return
            token = headers.get(b"x-jarvis-session-token", b"").decode("latin-1")
            if not self.sessions.is_valid(token):
                await self._reject(
                    send,
                    403,
                    "browser_session_required",
                    "A valid browser session is required for this request.",
                )
                return

        if method == "OPTIONS":
            await self.app(scope, receive, send)
            return

        client = scope.get("client")
        client_host = str(client[0]) if client else "unknown"
        if self._rate_limited(client_host):
            await self._reject(send, 429, "rate_limited", "Too many local API requests.")
            return

        content_length = headers.get(b"content-length")
        if content_length is not None:
            try:
                declared_size = int(content_length)
            except ValueError:
                await self._reject(send, 400, "invalid_content_length", "Invalid request size.")
                return
            if declared_size < 0 or declared_size > self.max_request_bytes:
                await self._reject(
                    send, 413, "request_too_large", "Request exceeds the size limit."
                )
                return

        if not bootstrap_path and not (liveness_path and origin_present):
            token = headers.get(b"x-jarvis-session-token", b"").decode("latin-1")
            if not self.sessions.is_valid(token):
                await self._reject(
                    send, 401, "browser_session_required", "Start a new browser session."
                )
                return

        body_parts: list[bytes] = []
        body_size = 0
        more_body = True
        while more_body:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            body = message.get("body", b"")
            body_size += len(body)
            if body_size > self.max_request_bytes:
                await self._reject(
                    send, 413, "request_too_large", "Request exceeds the size limit."
                )
                return
            body_parts.append(body)
            more_body = message.get("more_body", False)

        request_body = b"".join(body_parts)
        if not origin_present and request_body:
            await self._reject(
                send, 403, "origin_required", "This request requires an allowed Origin."
            )
            return
        body_sent = False

        async def replay_receive() -> ASGIMessage:
            nonlocal body_sent
            if body_sent:
                return {"type": "http.request", "body": b"", "more_body": False}
            body_sent = True
            return {"type": "http.request", "body": request_body, "more_body": False}

        await self.app(scope, replay_receive, send)

    @staticmethod
    def _is_safe_get_path(path: str) -> bool:
        return path in _SAFE_GET_PATHS or any(
            pattern.fullmatch(path) for pattern in _SAFE_GET_PATH_PATTERNS
        )

    @staticmethod
    def _is_loopback_client(client: Any) -> bool:
        if not isinstance(client, (tuple, list)) or not client:
            return False
        try:
            address = ipaddress.ip_address(str(client[0]))
        except ValueError:
            return False
        return str(address) in {"127.0.0.1", "::1"}

    def _rate_limited(self, client_host: str) -> bool:
        now = time.monotonic()
        requests = self._request_times[client_host]
        while requests and now - requests[0] >= 60:
            requests.popleft()
        if len(requests) >= self.requests_per_minute:
            return True
        requests.append(now)
        return False

    @staticmethod
    async def _reject(send: ASGISend, status_code: int, code: str, message: str) -> None:
        request_id = str(uuid4())
        body = json.dumps(
            {
                "error": {"code": code, "message": message, "details": []},
                "requestId": request_id,
            }
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": status_code,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                    (b"cache-control", b"no-store"),
                    (b"x-correlation-id", request_id.encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
