"""Tappi AI chats.

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

TZ = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "ai_conversations",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("user_id", sa.Uuid, sa.ForeignKey("app.users.id", ondelete="CASCADE"), nullable=False),
        # The first thing the user said, shortened.
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("created_at", TZ, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", TZ, nullable=False, server_default=sa.func.now()),
        schema="app",
    )
    op.create_index("ai_conversations_user_idx", "ai_conversations", ["user_id", "updated_at"], schema="app")
    op.create_table(
        "ai_messages",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column(
            "conversation_id", sa.Uuid, sa.ForeignKey("app.ai_conversations.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("user_id", sa.Uuid, sa.ForeignKey("app.users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.Text, nullable=False),
        sa.Column("content", sa.Text, nullable=False),
        # Assistant only: actions it prepared (send, open a screen), shown as buttons.
        sa.Column("actions", sa.JSON),
        # User only: true when the message was spoken (the content is the transcript).
        sa.Column("spoken", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("created_at", TZ, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("role IN ('user', 'assistant')", name="ai_messages_role_check"),
        schema="app",
    )
    op.create_index("ai_messages_conversation_idx", "ai_messages", ["conversation_id", "created_at"], schema="app")


def downgrade() -> None:
    op.drop_table("ai_messages", schema="app")
    op.drop_table("ai_conversations", schema="app")
