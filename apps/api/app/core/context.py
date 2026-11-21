"""Request-scoped correlation context for logs and API responses."""

from contextvars import ContextVar

request_id_context: ContextVar[str] = ContextVar("request_id", default="-")
