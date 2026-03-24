FROM python:3.12-slim

WORKDIR /app

# Install uv for fast dependency resolution
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy project files
COPY pyproject.toml uv.lock* ./
COPY src/ src/

# Install dependencies
RUN uv sync --frozen --no-dev

# Create runtime directories
RUN mkdir -p state wallets

ENV PYTHONUNBUFFERED=1

CMD ["uv", "run", "pr-agent"]
