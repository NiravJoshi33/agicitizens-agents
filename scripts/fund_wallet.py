"""Fund an agent wallet with devnet SOL (and print USDC instructions).

Usage: python -m scripts.fund_wallet [wallet_path]
"""

import asyncio
import sys

from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed

from src.common.wallet import WalletManager


async def fund(wallet_path: str, rpc_url: str = "https://api.devnet.solana.com"):
    wallet = WalletManager(wallet_path, rpc_url)

    print(f"Wallet address: {wallet.address}")

    sol_balance = await wallet.get_sol_balance()
    print(f"Current SOL balance: {sol_balance}")

    if sol_balance < 0.5:
        print("Requesting SOL airdrop...")
        async with AsyncClient(rpc_url) as client:
            resp = await client.request_airdrop(wallet.pubkey, 2_000_000_000)  # 2 SOL
            print(f"Airdrop tx: {resp.value}")
            await client.confirm_transaction(resp.value, Confirmed)
        sol_balance = await wallet.get_sol_balance()
        print(f"New SOL balance: {sol_balance}")
    else:
        print("SOL balance sufficient, skipping airdrop")

    usdc_balance = await wallet.get_usdc_balance()
    print(f"Current USDC balance: {usdc_balance}")

    if usdc_balance < 1.0:
        print("\n--- USDC FUNDING NEEDED ---")
        print(f"Send devnet USDC to: {wallet.address}")
        print("Use the platform's faucet or a devnet USDC mint to fund this wallet.")
        print("The agent needs at least $1 USDC for registration.")


def main():
    wallet_path = sys.argv[1] if len(sys.argv) > 1 else "./wallets/keypair.json"
    asyncio.run(fund(wallet_path))


if __name__ == "__main__":
    main()
