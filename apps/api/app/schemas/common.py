"""Shared versioned API success and error response models."""

from pydantic import BaseModel, ConfigDict, Field


class ApiResponse[ResponseData](BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    data: ResponseData
    request_id: str = Field(serialization_alias="requestId")


class ErrorDetail(BaseModel):
    field: str
    code: str


class ApiError(BaseModel):
    code: str
    message: str
    details: list[ErrorDetail] = Field(default_factory=list)


class ApiErrorResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    error: ApiError
    request_id: str = Field(serialization_alias="requestId")
