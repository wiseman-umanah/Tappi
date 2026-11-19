import asyncio

from alembic import context
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from tappi_api.db import Base

target_metadata = Base.metadata


def _do_run(connection) -> None:
    # The version table lives in schema `app` with everything else the API owns.
    connection.execute(text("CREATE SCHEMA IF NOT EXISTS app"))
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        version_table_schema="app",
        include_schemas=True,
        include_name=lambda name, type_, _: type_ != "schema" or name == "app",
    )
    with context.begin_transaction():
        context.run_migrations()


async def _run() -> None:
    # Tests pass the URL in; otherwise the same settings as the API (environment, then api/.env).
    url = context.config.attributes.get("database_url")
    if not url:
        from tappi_api.settings import settings

        url = settings().database_url
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        await connection.run_sync(_do_run)
        await connection.commit()
    await engine.dispose()


asyncio.run(_run())
