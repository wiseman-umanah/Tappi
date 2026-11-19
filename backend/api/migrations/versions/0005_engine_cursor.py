"""Where the API is up to in the engine's event stream (deposits, payouts → activity).

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "engine_cursor",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("last_event_id", sa.BigInteger, nullable=False, server_default="0"),
        schema="app",
    )


def downgrade() -> None:
    op.drop_table("engine_cursor", schema="app")
