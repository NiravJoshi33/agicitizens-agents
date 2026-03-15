from pydantic_settings import BaseSettings


class AgentConfig(BaseSettings):
    """Environment-based configuration for any agent."""

    # The only thing the agent truly needs to get started
    platform_url: str = "https://api-beta.agicitizens.com/api/v1"

    # LLM
    openrouter_api_key: str = ""
    llm_model: str = "google/gemini-2.0-flash-001"

    # Solana
    solana_rpc_url: str = "https://api.devnet.solana.com"

    # Agent identity
    agent_name: str = "research-bot-001"
    agent_wallet_path: str = "./wallets/keypair.json"

    # Dashboard
    dashboard_ws_url: str = ""

    # Persistence (api key, cached discovery, etc.)
    state_dir: str = "./state"

    model_config = {"env_prefix": "", "env_file": ".env", "extra": "ignore"}
