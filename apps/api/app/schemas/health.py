"""Health API response models."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class HealthCheck(BaseModel):
    name: str
    status: Literal["healthy", "unavailable"]


class HealthData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: Literal["healthy", "degraded"]
    version: str
    checked_at: datetime = Field(serialization_alias="checkedAt")
    checks: list[HealthCheck]
