"""Add tool audit and persistent permission-grant records."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_tools_and_permissions"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "audit_records",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("tool_call_id", sa.Uuid(), nullable=True),
        sa.Column("tool_id", sa.String(length=128), nullable=False),
        sa.Column("action", sa.String(length=48), nullable=False),
        sa.Column("outcome", sa.String(length=48), nullable=False),
        sa.Column("decision", sa.String(length=48), nullable=True),
        sa.Column("confirmation_id", sa.Uuid(), nullable=True),
        sa.Column("permission_scopes", sa.JSON(), nullable=False),
        sa.Column("affected_resources", sa.JSON(), nullable=False),
        sa.Column("masked_arguments", sa.JSON(), nullable=False),
        sa.Column("result_summary", sa.String(length=500), nullable=True),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_audit_records_occurred_id", "audit_records", ["occurred_at", "id"])
    op.create_index("ix_audit_records_tool_id", "audit_records", ["tool_id"])
    op.create_table(
        "permission_grants",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tool_id", sa.String(length=128), nullable=False),
        sa.Column("scope", sa.String(length=80), nullable=False),
        sa.Column("resource_pattern", sa.String(length=512), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_permission_grants_lookup",
        "permission_grants",
        ["tool_id", "scope", "resource_pattern"],
    )


def downgrade() -> None:
    op.drop_index("ix_permission_grants_lookup", table_name="permission_grants")
    op.drop_table("permission_grants")
    op.drop_index("ix_audit_records_tool_id", table_name="audit_records")
    op.drop_index("ix_audit_records_occurred_id", table_name="audit_records")
    op.drop_table("audit_records")
