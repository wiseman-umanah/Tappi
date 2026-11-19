"""Merchant charges, and linking activity rows to the charge they came from.

Revision ID: 0002
Revises: 0001
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

TZ = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "payment_requests",
        sa.Column("id", sa.Uuid, primary_key=True),
        # Short code a customer can type when tapping and scanning aren't possible.
        sa.Column("code", sa.Text, nullable=False, unique=True),
        sa.Column("merchant_id", sa.Uuid, sa.ForeignKey("app.users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("amount", sa.BigInteger, nullable=False),
        sa.Column("asset", sa.Text, nullable=False),
        sa.Column("tag", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default="pending"),
        sa.Column("payer_id", sa.Uuid, sa.ForeignKey("app.users.id", ondelete="SET NULL")),
        sa.Column("pay_asset", sa.Text),
        sa.Column("channel", sa.Text),
        sa.Column("tapped_by", sa.Uuid, sa.ForeignKey("app.users.id", ondelete="SET NULL")),
        sa.Column("tapped_at", TZ),
        sa.Column("card_brand", sa.Text),
        sa.Column("ledger_entry_id", sa.Uuid),
        sa.Column("refund_entry_id", sa.Uuid),
        sa.Column("expires_at", TZ, nullable=False),
        sa.Column("paid_at", TZ),
        sa.Column("created_at", TZ, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("amount > 0", name="payment_requests_amount_check"),
        sa.CheckConstraint(
            "status IN ('pending', 'paid', 'refunded', 'cancelled')", name="payment_requests_status_check"
        ),
        schema="app",
    )
    op.create_index("payment_requests_merchant_idx", "payment_requests", ["merchant_id", "created_at"], schema="app")
    # One feed row per user per asset per engine entry (an account closure sweeps several assets).
    op.drop_index("entries_ledger_idx", "entries", schema="app")
    op.create_index("entries_ledger_idx", "entries", ["ledger_entry_id", "user_id", "asset"], unique=True, schema="app")
    op.add_column(
        "entries",
        sa.Column("request_id", sa.Uuid, sa.ForeignKey("app.payment_requests.id", ondelete="SET NULL")),
        schema="app",
    )


def downgrade() -> None:
    op.drop_column("entries", "request_id", schema="app")
    op.drop_index("entries_ledger_idx", "entries", schema="app")
    op.create_index("entries_ledger_idx", "entries", ["ledger_entry_id", "user_id"], unique=True, schema="app")
    op.drop_table("payment_requests", schema="app")
