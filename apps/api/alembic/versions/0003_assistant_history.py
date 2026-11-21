"""Add assistant conversation and task history."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_assistant_history"
down_revision: str | None = "0002_tools_and_permissions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "conversations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "conversation_messages",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("command_id", sa.Uuid(), nullable=False),
        sa.Column("task_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_conversation_messages_history",
        "conversation_messages",
        ["conversation_id", "created_at", "id"],
    )
    op.create_table(
        "assistant_tasks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("command_id", sa.Uuid(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("assistant_state", sa.String(length=32), nullable=False),
        sa.Column("masked_transcript", sa.Text(), nullable=False),
        sa.Column("intent", sa.JSON(), nullable=True),
        sa.Column("plan", sa.JSON(), nullable=True),
        sa.Column("tool_results", sa.JSON(), nullable=False),
        sa.Column("assistant_message", sa.Text(), nullable=True),
        sa.Column("confirmation_id", sa.Uuid(), nullable=True),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_assistant_tasks_conversation_created",
        "assistant_tasks",
        ["conversation_id", "created_at"],
    )
    op.create_index("ix_assistant_tasks_command_id", "assistant_tasks", ["command_id"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_assistant_tasks_command_id", table_name="assistant_tasks")
    op.drop_index("ix_assistant_tasks_conversation_created", table_name="assistant_tasks")
    op.drop_table("assistant_tasks")
    op.drop_index("ix_conversation_messages_history", table_name="conversation_messages")
    op.drop_table("conversation_messages")
    op.drop_table("conversations")
