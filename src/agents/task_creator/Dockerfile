FROM python:3.12-slim

# Install curl for Claude to use
RUN apt-get update && apt-get install -y --no-install-recommends curl jq && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml .
RUN pip install --no-cache-dir .

COPY src/ src/

# Wallet and state are mounted as volumes
VOLUME ["/app/wallets", "/app/state"]

ENV AGENT_WALLET_PATH=/app/wallets/keypair.json
ENV STATE_DIR=/app/state
ENV AGENT_NAME=task-creator-001

# Claude-powered agent with tool use
CMD ["python", "-m", "src.agents.task_creator.agent"]
