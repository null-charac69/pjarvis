"""Async database lifecycle and request-scoped SQLAlchemy sessions."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable
from pathlib import Path

from alembic import command
from alembic.config import Config
from fastapi import Request
from sqlalchemy import text
from sqlalchemy.engine import Connection, make_url
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.settings import REPOSITORY_ROOT, Settings


async def finish_database_operation[Result](operation: Awaitable[Result]) -> Result:
    operation_task = asyncio.ensure_future(operation)
    try:
        return await asyncio.shield(operation_task)
    except asyncio.CancelledError:
        await asyncio.shield(operation_task)
        raise


def _ensure_sqlite_parent(database_path: str) -> None:
    Path(database_path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)


class Database:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        url = make_url(settings.database_url_value)
        if url.drivername == "sqlite":
            url = url.set(drivername="sqlite+aiosqlite")
        elif url.drivername == "postgresql":
            url = url.set(drivername="postgresql+asyncpg")
        self._url = url
        engine_options: dict[str, object] = {"pool_pre_ping": True}
        if self._url.get_backend_name() == "sqlite":
            engine_options["connect_args"] = {"timeout": 5.0}
        self.engine: AsyncEngine = create_async_engine(self._url, **engine_options)
        self.session_factory = async_sessionmaker(self.engine, expire_on_commit=False)

    async def start(self) -> None:
        database_path = self._url.database
        is_file_sqlite = (
            self._url.get_backend_name() == "sqlite"
            and database_path is not None
            and database_path != ":memory:"
        )
        if is_file_sqlite and database_path is not None:
            await asyncio.to_thread(_ensure_sqlite_parent, database_path)
            async with self.engine.connect() as connection:
                await connection.exec_driver_sql("PRAGMA journal_mode=WAL")
                await connection.commit()
        async with self.engine.begin() as connection:
            await connection.run_sync(self._upgrade_schema)

    def _upgrade_schema(self, connection: Connection) -> None:
        configuration = Config(str(REPOSITORY_ROOT / "alembic.ini"))
        configuration.attributes["connection"] = connection
        configuration.attributes["settings"] = self._settings
        command.upgrade(configuration, "head")

    async def ping(self) -> bool:
        async with self.engine.connect() as connection:
            return (await connection.execute(text("SELECT 1"))).scalar_one() == 1

    async def stop(self) -> None:
        await self.engine.dispose()


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    database: Database = request.app.state.database
    async with database.session_factory() as session:
        yield session
