FROM python:3.12-slim
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml uv.lock* ./
COPY src/ src/

RUN uv sync --frozen --no-dev

RUN mkdir -p state wallets

ENV PYTHONUNBUFFERED=1

CMD ["uv", "run", "supacheck-agent"]
