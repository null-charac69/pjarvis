"""Persistence boundary for masked, append-only tool audit records."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.session import finish_database_operation
from app.models.audit import AuditRecord
from app.tools.security import mask_secrets


class AuditService:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def append(
        self,
        *,
        request_id: UUID,
        tool_id: str,
        action: str,
        outcome: str,
        tool_call_id: UUID | None = None,
        decision: str | None = None,
        confirmation_id: UUID | None = None,
        permission_scopes: Sequence[str] = (),
        affected_resources: Sequence[str] = (),
        arguments: dict[str, Any] | None = None,
        result_summary: str | None = None,
        error_code: str | None = None,
        duration_ms: int | None = None,
    ) -> AuditRecord:
        record = AuditRecord(
            request_id=request_id,
            tool_call_id=tool_call_id,
            tool_id=tool_id[:128],
            action=action[:48],
            outcome=outcome[:48],
            decision=decision[:48] if decision else None,
            confirmation_id=confirmation_id,
            permission_scopes=list(permission_scopes),
            affected_resources=mask_secrets(list(affected_resources)),
            masked_arguments=mask_secrets(arguments or {}),
            result_summary=mask_secrets(result_summary)[:500] if result_summary else None,
            error_code=error_code[:64] if error_code else None,
            duration_ms=max(duration_ms, 0) if duration_ms is not None else None,
            occurred_at=datetime.now(UTC),
        )
        async with self._session_factory() as session:
            session.add(record)
            await finish_database_operation(session.commit())
            await session.refresh(record)
        return record

    async def list_records(self, limit: int = 100, offset: int = 0) -> list[AuditRecord]:
        async with self._session_factory() as session:
            result = await session.scalars(
                select(AuditRecord)
                .order_by(AuditRecord.occurred_at.desc(), AuditRecord.id.desc())
                .limit(limit)
                .offset(offset)
            )
            return list(result.all())
