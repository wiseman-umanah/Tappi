# Tappi API: migrates the app schema, then serves on 8080 behind Caddy.
FROM python:3.13-slim-trixie
COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY alembic.ini ./
COPY migrations ./migrations
COPY src ./src
RUN uv sync --locked --no-dev && useradd --system --uid 10002 api
USER api
ENV PATH=/app/.venv/bin:$PATH API_HOST=0.0.0.0 API_PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "alembic upgrade head && exec tappi-api"]
