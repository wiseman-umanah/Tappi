"""Users, sign-in and the activity feed.

Revision ID: 0001
Revises:
"""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

TZ = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("email", sa.Text, unique=True),
        sa.Column("email_hash", sa.Text),
        sa.Column("handle", sa.Text, unique=True),
        sa.Column("name", sa.Text),
        sa.Column("gender", sa.Text),
        sa.Column("pin_hash", sa.Text),
        sa.Column("pin_failures", sa.Integer, nullable=False, server_default="0"),
        sa.Column("pin_locked_until", TZ),
        sa.Column("status", sa.Text, nullable=False, server_default="active"),
        sa.Column("language", sa.Text, nullable=False, server_default="en"),
        sa.Column("welcomed", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("delete_after", TZ),
        sa.Column("closed_at", TZ),
        sa.Column("retain_until", TZ),
        sa.Column("created_at", TZ, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("status IN ('active', 'disabled', 'deleting', 'closed')", name="users_status_check"),
        sa.CheckConstraint("gender IN ('female', 'male')", name="users_gender_check"),
        schema="app",
    )
    op.create_table(
        "login_codes",
        sa.Column("email", sa.Text, primary_key=True),
        sa.Column("code_hash", sa.Text, nullable=False),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("expires_at", TZ, nullable=False),
        schema="app",
    )
    op.create_table(
        "sessions",
        sa.Column("token_hash", sa.Text, primary_key=True),
        sa.Column("user_id", sa.Uuid, sa.ForeignKey("app.users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("expires_at", TZ, nullable=False),
        sa.Column("created_at", TZ, nullable=False, server_default=sa.func.now()),
        schema="app",
    )
    op.create_table(
        "entries",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("user_id", sa.Uuid, sa.ForeignKey("app.users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("tag", sa.Text, nullable=False),
        sa.Column("asset", sa.Text, nullable=False),
        sa.Column("amount", sa.BigInteger, nullable=False),
        sa.Column("asset_in", sa.Text),
        sa.Column("amount_in", sa.BigInteger),
        sa.Column("channel", sa.Text),
        sa.Column("ledger_entry_id", sa.Uuid, nullable=False),
        sa.Column("created_at", TZ, nullable=False, server_default=sa.func.now()),
        schema="app",
    )
    op.create_index("entries_user_idx", "entries", ["user_id", "created_at"], schema="app")
    op.create_index("entries_ledger_idx", "entries", ["ledger_entry_id", "user_id"], unique=True, schema="app")


def downgrade() -> None:
    op.drop_table("entries", schema="app")
    op.drop_table("sessions", schema="app")
    op.drop_table("login_codes", schema="app")
    op.drop_table("users", schema="app")
