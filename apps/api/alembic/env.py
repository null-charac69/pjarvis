"""Alembic environment supporting CLI and application-managed async connections."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection, make_url
from sqlalchemy.ext.asyncio import async_engine_from_config

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.settings import get_settings  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.models import (  # noqa: E402,F401
    AssistantTaskRecord,
    AuditRecord,
    ConversationMessageRecord,
    ConversationRecord,
    PermissionGrantRecord,
    ReminderRecord,
)

configuration = context.config
settings = configuration.attributes.get("settings") or get_settings()
database_url = settings.database_url_value
configuration.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
target_metadata = Base.metadata


def run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        render_as_batch=make_url(database_url).get_backend_name() == "sqlite",
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        configuration.get_section(configuration.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    try:
        async with connectable.connect() as connection:
            await connection.run_sync(run_migrations)
    finally:
        await connectable.dispose()


def run_migrations_online() -> None:
    connection = configuration.attributes.get("connection")
    if connection is not None:
        run_migrations(connection)
    else:
        asyncio.run(run_async_migrations())


if context.is_offline_mode():
    context.configure(url=database_url, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()
else:
    run_migrations_online()
