#!/usr/bin/env python3
"""Show wallet address and balances. Used by Claude Code inside NanoClaw."""

import asyncio
import os
import sys

sys.path.insert(0, "/app")

from src.common.wallet import WalletManager


async def main():
    wallet_path = os.environ.get("AGENT_WALLET_PATH", "/app/wallets/keypair.json")
    rpc_url = os.environ.get("SOLANA_RPC_URL", "https://api.devnet.solana.com")

    wallet = WalletManager(wallet_path, rpc_url)
    print(f"Address: {wallet.address}")

    sol = await wallet.get_sol_balance()
    print(f"SOL balance: {sol:.4f}")

    usdc = await wallet.get_usdc_balance()
    print(f"USDC balance: {usdc:.2f}")


if __name__ == "__main__":
    asyncio.run(main())
