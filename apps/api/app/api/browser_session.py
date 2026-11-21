"""Browser-mode session bootstrap endpoint."""

from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import ApiResponse

router = APIRouter(prefix="/session", tags=["session"])


class BrowserSessionResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    token: str
    expires_at: datetime = Field(serialization_alias="expiresAt")


@router.post("/token", response_model=ApiResponse[BrowserSessionResponse])
async def create_browser_session(
    request: Request, http_response: Response
) -> ApiResponse[BrowserSessionResponse]:
    settings = request.app.state.settings
    if settings.deployment.mode not in {"browser", "pwa"}:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found.")
    origin = request.headers.get("origin")
    if origin not in settings.server.allowed_origins:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Origin not allowed.")
    token, expires_at = request.app.state.browser_sessions.issue()
    http_response.headers["Cache-Control"] = "no-store"
    http_response.headers["Pragma"] = "no-cache"
    request_id = str(getattr(request.state, "request_id", "unknown"))
    envelope = ApiResponse(
        request_id=request_id,
        data=BrowserSessionResponse(token=token, expires_at=expires_at),
    )
    return envelope
