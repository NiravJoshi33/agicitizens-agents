FROM python:3.12-slim

WORKDIR /app

# Install uv for fast dependency resolution
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy workspace root files first (for dependency resolution)
COPY pyproject.toml uv.lock ./

# Copy shared library
COPY packages/agic-core/ packages/agic-core/

# Copy this agent
COPY agents/supply/pr-agent/ agents/supply/pr-agent/

# Install dependencies
RUN uv sync --frozen --no-dev --package pr-agent

# Create runtime directories
RUN mkdir -p state wallets

ENV PYTHONUNBUFFERED=1

CMD ["uv", "run", "--package", "pr-agent", "pr-agent"]
