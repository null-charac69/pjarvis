"""Consistent, non-sensitive HTTP error responses."""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.schemas.common import ApiError, ApiErrorResponse, ErrorDetail

logger = logging.getLogger(__name__)


def _error_response(
    request: Request,
    status_code: int,
    code: str,
    message: str,
    details: list[ErrorDetail] | None = None,
) -> JSONResponse:
    body = ApiErrorResponse(
        request_id=getattr(request.state, "request_id", "unknown"),
        error=ApiError(code=code, message=message, details=details or []),
    )
    return JSONResponse(
        status_code=status_code,
        content=body.model_dump(mode="json", by_alias=True),
    )


async def http_exception_handler(request: Request, exception: Exception) -> JSONResponse:
    if not isinstance(exception, StarletteHTTPException):
        raise exception
    status_messages = {
        400: ("bad_request", "The request could not be processed."),
        401: ("unauthorized", "Authentication is required."),
        403: ("forbidden", "The request is not permitted."),
        404: ("not_found", "The requested resource was not found."),
        405: ("method_not_allowed", "The request method is not supported."),
    }
    code, message = status_messages.get(
        exception.status_code,
        ("request_failed", "The request could not be completed."),
    )
    return _error_response(request, exception.status_code, code, message)


async def validation_exception_handler(request: Request, exception: Exception) -> JSONResponse:
    if not isinstance(exception, RequestValidationError):
        raise exception
    details = [
        ErrorDetail(
            field=".".join(str(part)[:48] for part in error.get("loc", ()) if part != "body")[:120],
            code=str(error.get("type", "invalid"))[:64],
        )
        for error in exception.errors()
    ]
    return _error_response(
        request,
        422,
        "invalid_request",
        "One or more request fields are invalid.",
        details,
    )


async def unhandled_exception_handler(request: Request, exception: Exception) -> JSONResponse:
    logger.error("Unhandled API exception type=%s", type(exception).__name__)
    return _error_response(
        request,
        500,
        "internal_error",
        "An internal error occurred.",
    )


def install_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
