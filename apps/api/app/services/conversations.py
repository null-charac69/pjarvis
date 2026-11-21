"""Persistence operations for masked conversation content and task metadata."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.engine import CursorResult
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.session import finish_database_operation
from app.models.conversations import (
    AssistantTaskRecord,
    ConversationMessageRecord,
    ConversationRecord,
)
from app.tools.security import mask_secrets


class ConversationNotFoundError(Exception):
    pass


class ConversationService:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def mark_interrupted_tasks(self) -> int:
        async with self._session_factory() as session:
            result = cast(
                CursorResult[Any],
                await session.execute(
                    update(AssistantTaskRecord)
                    .where(
                        AssistantTaskRecord.status.in_(
                            ("pending", "running", "awaiting_confirmation")
                        )
                    )
                    .values(
                        status="failed",
                        assistant_state="failed",
                        confirmation_id=None,
                        error_code="interrupted_by_restart",
                        updated_at=datetime.now(UTC),
                    )
                ),
            )
            await session.commit()
            return result.rowcount or 0

    async def create_command(
        self,
        *,
        command_id: UUID,
        task_id: UUID,
        conversation_id: UUID | None,
        transcript: str,
    ) -> tuple[UUID, AssistantTaskRecord]:
        now = datetime.now(UTC)
        async with self._session_factory() as session:
            if conversation_id is None:
                conversation = ConversationRecord(created_at=now, updated_at=now)
                session.add(conversation)
                await finish_database_operation(session.flush())
                conversation_id = conversation.id
            else:
                existing_conversation = await session.get(ConversationRecord, conversation_id)
                if existing_conversation is None:
                    raise ConversationNotFoundError("conversation_not_found")
                existing_conversation.updated_at = now

            task = AssistantTaskRecord(
                id=task_id,
                command_id=command_id,
                conversation_id=conversation_id,
                status="pending",
                assistant_state="idle",
                masked_transcript=str(mask_secrets(transcript)),
                intent=None,
                plan=None,
                tool_results=[],
                created_at=now,
                updated_at=now,
            )
            session.add(task)
            session.add(
                ConversationMessageRecord(
                    conversation_id=conversation_id,
                    command_id=command_id,
                    task_id=task_id,
                    role="user",
                    content=str(mask_secrets(transcript)),
                    created_at=now,
                )
            )
            await finish_database_operation(session.commit())
            await session.refresh(task)
            return conversation_id, task

    async def update_task(
        self,
        task_id: UUID,
        *,
        status: str,
        assistant_state: str,
        intent: dict[str, Any] | None,
        plan: dict[str, Any] | None,
        tool_results: list[dict[str, Any]],
        assistant_message: str | None,
        confirmation_id: UUID | None,
        error_code: str | None,
    ) -> AssistantTaskRecord:
        async with self._session_factory() as session:
            task = await session.get(AssistantTaskRecord, task_id)
            if task is None:
                raise ConversationNotFoundError("task_not_found")
            task.status = status
            task.assistant_state = assistant_state
            task.intent = mask_secrets(intent) if intent is not None else None
            task.plan = mask_secrets(plan) if plan is not None else None
            task.tool_results = mask_secrets(tool_results)
            task.assistant_message = (
                str(mask_secrets(assistant_message)) if assistant_message is not None else None
            )
            task.confirmation_id = confirmation_id
            task.error_code = error_code
            task.updated_at = datetime.now(UTC)
            await finish_database_operation(session.commit())
            await session.refresh(task)
            return task

    async def add_assistant_message(
        self,
        *,
        conversation_id: UUID,
        command_id: UUID,
        task_id: UUID,
        content: str,
    ) -> ConversationMessageRecord:
        now = datetime.now(UTC)
        safe_content = str(mask_secrets(content))
        async with self._session_factory() as session:
            conversation = await session.get(ConversationRecord, conversation_id)
            if conversation is None:
                raise ConversationNotFoundError("conversation_not_found")
            conversation.updated_at = now
            message = ConversationMessageRecord(
                conversation_id=conversation_id,
                command_id=command_id,
                task_id=task_id,
                role="assistant",
                content=safe_content,
                created_at=now,
            )
            session.add(message)
            await finish_database_operation(session.commit())
            await session.refresh(message)
            return message

    async def get_task(self, task_id: UUID) -> AssistantTaskRecord | None:
        async with self._session_factory() as session:
            return await session.get(AssistantTaskRecord, task_id)

    async def get_command(self, command_id: UUID) -> AssistantTaskRecord | None:
        async with self._session_factory() as session:
            result = await session.scalars(
                select(AssistantTaskRecord).where(AssistantTaskRecord.command_id == command_id)
            )
            return result.first()

    async def list_tasks(
        self, *, limit: int = 100, offset: int = 0, conversation_id: UUID | None = None
    ) -> list[AssistantTaskRecord]:
        statement = select(AssistantTaskRecord).order_by(
            AssistantTaskRecord.created_at.desc(), AssistantTaskRecord.id.desc()
        )
        if conversation_id is not None:
            statement = statement.where(AssistantTaskRecord.conversation_id == conversation_id)
        async with self._session_factory() as session:
            result = await session.scalars(statement.limit(limit).offset(offset))
            return list(result.all())

    async def list_messages(
        self, conversation_id: UUID, *, limit: int = 100, offset: int = 0
    ) -> list[ConversationMessageRecord]:
        async with self._session_factory() as session:
            result = await session.scalars(
                select(ConversationMessageRecord)
                .where(ConversationMessageRecord.conversation_id == conversation_id)
                .order_by(ConversationMessageRecord.created_at, ConversationMessageRecord.id)
                .limit(limit)
                .offset(offset)
            )
            return list(result.all())
