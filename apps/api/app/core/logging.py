"""Structured JSON logging with conservative secret redaction."""

from __future__ import annotations

import json
import logging
import re
import sys
from datetime import UTC, datetime
from typing import Any

from app.core.context import request_id_context

_SECRET_PATTERN = re.compile(
    r"(?i)(api[_-]?key|password|access[_-]?token|authorization|secret)(\s*[:=]\s*)([^\s,;&]+)"
)
_BEARER_PATTERN = re.compile(r"(?i)\bBearer\s+\S+")


class SecretRedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        message = _BEARER_PATTERN.sub("Bearer [REDACTED]", message)
        record.msg = _SECRET_PATTERN.sub(r"\1\2[REDACTED]", message)
        record.args = ()
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "requestId": request_id_context.get(),
        }
        return json.dumps(payload, ensure_ascii=True, separators=(",", ":"))


def configure_logging(level: str) -> None:
    root_logger = logging.getLogger()
    root_logger.setLevel(level)
    if any(getattr(handler, "_jarvis_handler", False) for handler in root_logger.handlers):
        return

    handler = logging.StreamHandler(sys.stdout)
    handler._jarvis_handler = True  # type: ignore[attr-defined]
    handler.addFilter(SecretRedactionFilter())
    handler.setFormatter(JsonFormatter())
    root_logger.addHandler(handler)
