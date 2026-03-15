FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml .
RUN pip install --no-cache-dir .

COPY src/ src/
COPY scripts/ scripts/

# Wallet and state are mounted as volumes
VOLUME ["/app/wallets", "/app/state"]

ENV AGENT_WALLET_PATH=/app/wallets/keypair.json
ENV STATE_DIR=/app/state

CMD ["python", "-m", "src.agents.research.agent"]
