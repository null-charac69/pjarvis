"""Liveness and readiness endpoints for the local API service."""

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy.exc import SQLAlchemyError

from app import __version__
from app.db.session import Database
from app.schemas.common import ApiResponse
from app.schemas.health import HealthCheck, HealthData

router = APIRouter(prefix="/health", tags=["health"])


def _request_id(request: Request) -> str:
    return str(getattr(request.state, "request_id", "unknown"))


@router.get("/live", response_model=ApiResponse[HealthData])
async def liveness(request: Request) -> ApiResponse[HealthData]:
    return ApiResponse(
        request_id=_request_id(request),
        data=HealthData(
            status="healthy",
            version=__version__,
            checked_at=datetime.now(UTC),
            checks=[HealthCheck(name="api", status="healthy")],
        ),
    )


@router.get("", response_model=ApiResponse[HealthData])
@router.get("/ready", response_model=ApiResponse[HealthData])
async def readiness(request: Request) -> ApiResponse[HealthData]:
    database: Database = request.app.state.database
    try:
        database_ready = await database.ping()
    except SQLAlchemyError as exception:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database is unavailable.",
        ) from exception

    if not database_ready:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database is unavailable.",
        )

    return ApiResponse(
        request_id=_request_id(request),
        data=HealthData(
            status="healthy",
            version=__version__,
            checked_at=datetime.now(UTC),
            checks=[
                HealthCheck(name="api", status="healthy"),
                HealthCheck(name="database", status="healthy"),
            ],
        ),
    )
