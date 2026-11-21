"""Shared input/output safety helpers for built-in and third-party tools."""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

from pydantic import AnyHttpUrl, BaseModel

_SECRET_KEY = re.compile(
    r"(?i)(api[_-]?key|password|access[_-]?token|token|authorization|secret|credential|private[_-]?key|contents)"
)
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)([\"']?(?:api[_-]?key|password|access[_-]?token|token|authorization|secret|credential|private[_-]?key)[\"']?\s*[:=]\s*[\"']?)([^\s\"',;&}]+)"
)
_BEARER = re.compile(r"(?i)(\bBearer\s+)[A-Za-z0-9._~+/-]+=*")
_TOKEN = re.compile(r"\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b")
_PRIVATE_KEY_BLOCK = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
    flags=re.DOTALL,
)


def mask_secrets(value: Any) -> Any:
    """Recursively replace recognizable secret values before display or audit."""
    if isinstance(value, BaseModel):
        return mask_secrets(value.model_dump(mode="json", by_alias=True))
    if isinstance(value, Mapping):
        return {
            str(key): "[REDACTED]" if _SECRET_KEY.search(str(key)) else mask_secrets(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [mask_secrets(item) for item in value]
    if isinstance(value, str):
        masked = _PRIVATE_KEY_BLOCK.sub("[REDACTED PRIVATE KEY]", value)
        masked = _BEARER.sub(r"\1[REDACTED]", masked)
        masked = _SECRET_ASSIGNMENT.sub(r"\1[REDACTED]", masked)
        return _TOKEN.sub("[REDACTED]", masked)
    return value


def validate_approved_website(
    value: str,
    approved_origins: list[AnyHttpUrl],
) -> str:
    """Accept only HTTPS URLs whose normalized origin is explicitly approved."""
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as exception:
        raise ValueError("Website URL is invalid or not approved.") from exception

    if parsed.scheme.lower() != "https" or not hostname or parsed.username or parsed.password:
        raise ValueError("Website URL is invalid or not approved.")
    if any(character in value for character in ("\r", "\n", "\x00")):
        raise ValueError("Website URL is invalid or not approved.")

    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ValueError("Website URL is invalid or not approved.")

    candidate_origin = (hostname.encode("idna").decode("ascii").lower(), port or 443)
    for allowed in approved_origins:
        allowed_host = (allowed.host or "").encode("idna").decode("ascii").lower()
        allowed_port = allowed.port or 443
        if candidate_origin == (allowed_host, allowed_port):
            return value
    raise ValueError("Website URL is invalid or not approved.")
