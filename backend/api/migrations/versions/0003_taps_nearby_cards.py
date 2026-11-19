"""Phone-to-phone taps, Bluetooth nearby beacons, and the Tappi card.

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

TZ = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "nearby_beacons",
        # 8 random bytes as hex: what the phone advertises over Bluetooth.
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("user_id", sa.Uuid, sa.ForeignKey("app.users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("request_id", sa.Uuid, sa.ForeignKey("app.payment_requests.id", ondelete="CASCADE")),
        sa.Column("expires_at", TZ, nullable=False),
        sa.Column("created_at", TZ, nullable=False, server_default=sa.func.now()),
        schema="app",
    )
    op.create_index("nearby_beacons_user_idx", "nearby_beacons", ["user_id"], schema="app")
    op.create_table(
        "person_taps",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("payer_id", sa.Uuid, sa.ForeignKey("app.users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("payee_id", sa.Uuid, sa.ForeignKey("app.users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", TZ, nullable=False, server_default=sa.func.now()),
        schema="app",
    )
    op.create_index("person_taps_payer_idx", "person_taps", ["payer_id", "created_at"], schema="app")
    op.create_table(
        "cards",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("user_id", sa.Uuid, sa.ForeignKey("app.users.id", ondelete="CASCADE"), nullable=False, unique=True),
        # Test number (Luhn-valid, not a real card range).
        sa.Column("number", sa.Text, nullable=False),
        sa.Column("exp_month", sa.Integer, nullable=False),
        sa.Column("exp_year", sa.Integer, nullable=False),
        sa.Column("cvv", sa.Text, nullable=False),
        sa.Column("frozen", sa.Boolean, nullable=False, server_default="false"),
        # Most the card may spend per day, in kobo.
        sa.Column("daily_limit", sa.BigInteger, nullable=False, server_default="10000000"),
        sa.Column("funding_asset", sa.Text, nullable=False, server_default="NGN"),
        sa.Column("armed_nonce", sa.Text),
        sa.Column("armed_until", TZ),
        sa.Column("created_at", TZ, nullable=False, server_default=sa.func.now()),
        schema="app",
    )


def downgrade() -> None:
    op.drop_table("cards", schema="app")
    op.drop_table("person_taps", schema="app")
    op.drop_table("nearby_beacons", schema="app")
