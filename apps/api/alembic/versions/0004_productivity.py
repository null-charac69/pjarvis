"""Add persistent local reminders."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_productivity"
down_revision: str | None = "0003_assistant_history"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "reminders",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_reminders_status_due", "reminders", ["status", "due_at"])


def downgrade() -> None:
    op.drop_index("ix_reminders_status_due", table_name="reminders")
    op.drop_table("reminders")
