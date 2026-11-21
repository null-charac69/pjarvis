"""Persistence operations for local reminders."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.session import finish_database_operation
from app.models.productivity import ReminderRecord
from app.tools.security import mask_secrets


class ProductivityService:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def create_reminder(self, title: str, due_at: datetime) -> ReminderRecord:
        reminder = ReminderRecord(
            title=str(mask_secrets(title)),
            due_at=due_at.astimezone(UTC),
            status="open",
            created_at=datetime.now(UTC),
        )
        async with self._session_factory() as session:
            session.add(reminder)
            await finish_database_operation(session.commit())
            await session.refresh(reminder)
        return reminder

    async def list_reminders(self, limit: int = 100) -> list[ReminderRecord]:
        async with self._session_factory() as session:
            rows = await session.scalars(
                select(ReminderRecord)
                .order_by(ReminderRecord.due_at, ReminderRecord.created_at)
                .limit(limit)
            )
            return list(rows.all())

    async def complete_reminder(self, reminder_id: UUID) -> ReminderRecord | None:
        async with self._session_factory() as session:
            reminder = await session.get(ReminderRecord, reminder_id)
            if reminder is None:
                return None
            reminder.status = "completed"
            await finish_database_operation(session.commit())
            await session.refresh(reminder)
            return reminder
