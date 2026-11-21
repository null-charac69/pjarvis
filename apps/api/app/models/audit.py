"""Append-only tool audit records and revocable persistent permission grants."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import JSON, DateTime, Index, Integer, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AuditRecord(Base):
    __tablename__ = "audit_records"
    __table_args__ = (
        Index("ix_audit_records_occurred_id", "occurred_at", "id"),
        Index("ix_audit_records_tool_id", "tool_id"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), nullable=False
    )
    request_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    tool_call_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    tool_id: Mapped[str] = mapped_column(String(128), nullable=False)
    action: Mapped[str] = mapped_column(String(48), nullable=False)
    outcome: Mapped[str] = mapped_column(String(48), nullable=False)
    decision: Mapped[str | None] = mapped_column(String(48), nullable=True)
    confirmation_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    permission_scopes: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    affected_resources: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    masked_arguments: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)
    result_summary: Mapped[str | None] = mapped_column(String(500), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)


class PermissionGrantRecord(Base):
    __tablename__ = "permission_grants"
    __table_args__ = (Index("ix_permission_grants_lookup", "tool_id", "scope", "resource_pattern"),)

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    tool_id: Mapped[str] = mapped_column(String(128), nullable=False)
    scope: Mapped[str] = mapped_column(String(80), nullable=False)
    resource_pattern: Mapped[str] = mapped_column(String(512), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
