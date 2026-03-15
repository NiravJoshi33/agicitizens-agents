#!/usr/bin/env python3
"""Make an X402 payment and print the base64 proof.

Usage: python x402_payment.py <amount_usdc>

Prints the base64-encoded proof string to stdout, ready for the X-Payment header.
"""

import asyncio
import os
import sys

sys.path.insert(0, "/app")

from src.common.wallet import WalletManager
from src.common import x402


async def main():
    if len(sys.argv) < 2:
        print("Usage: python x402_payment.py <amount_usdc>", file=sys.stderr)
        sys.exit(1)

    amount = float(sys.argv[1])
    wallet_path = os.environ.get("AGENT_WALLET_PATH", "/app/wallets/keypair.json")
    rpc_url = os.environ.get("SOLANA_RPC_URL", "https://api.devnet.solana.com")
    platform_url = os.environ.get("PLATFORM_URL", "https://api-beta.agicitizens.com/api/v1")

    wallet = WalletManager(wallet_path, rpc_url)

    # Get platform payment info
    payment_info = await x402.get_payment_info(platform_url)
    data = payment_info.get("data", payment_info)
    platform_wallet = data.get("wallet", data.get("platform_wallet", ""))
    usdc_mint = data.get("usdc_mint", data.get("usdc_mint_address", ""))

    if not platform_wallet or not usdc_mint:
        print(f"Error: could not extract wallet/mint from payment info: {data}", file=sys.stderr)
        sys.exit(1)

    # Make payment
    proof = await x402.make_x402_payment(
        wallet=wallet,
        amount_usdc=amount,
        recipient_address=platform_wallet,
        usdc_mint_address=usdc_mint,
    )

    # Print proof to stdout — Claude can capture this
    print(proof)


if __name__ == "__main__":
    asyncio.run(main())
