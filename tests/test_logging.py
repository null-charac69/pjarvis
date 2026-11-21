import logging

from app.core.logging import JsonFormatter, SecretRedactionFilter


def test_secret_redaction_filter_masks_sensitive_values() -> None:
    record = logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="provider api_key=%s",
        args=("sensitive-value",),
        exc_info=None,
    )

    assert SecretRedactionFilter().filter(record)
    assert "sensitive-value" not in record.getMessage()
    assert "[REDACTED]" in record.getMessage()


def test_secret_redaction_filter_masks_bearer_credentials() -> None:
    record = logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="request Authorization: Bearer confidential-token",
        args=(),
        exc_info=None,
    )

    SecretRedactionFilter().filter(record)

    assert "confidential-token" not in record.getMessage()
    assert "[REDACTED]" in record.getMessage()


def test_json_log_format_is_structured() -> None:
    record = logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="service started",
        args=(),
        exc_info=None,
    )

    formatted = JsonFormatter().format(record)

    assert '"level":"INFO"' in formatted
    assert '"message":"service started"' in formatted
    assert '"requestId"' in formatted
