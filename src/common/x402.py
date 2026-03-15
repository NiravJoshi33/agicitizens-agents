"""X402 payment protocol — Solana SPL USDC transfer + proof construction.

This is Solana plumbing, not platform-specific knowledge. The agent's LLM
decides *when* to pay and *how much*; this module handles the crypto mechanics.
"""

import base64
import json

import httpx
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.system_program import TransferParams, transfer
from solders.transaction import Transaction
from solders.message import Message
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from spl.token.constants import TOKEN_PROGRAM_ID
from spl.token.instructions import (
    TransferCheckedParams,
    transfer_checked,
)

from src.common.wallet import WalletManager

USDC_DECIMALS = 6


async def get_payment_info(platform_url: str) -> dict:
    """Fetch the platform's wallet address and USDC mint from x402/info."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{platform_url}/x402/info")
        resp.raise_for_status()
        return resp.json()


async def make_x402_payment(
    wallet: WalletManager,
    amount_usdc: float,
    recipient_address: str,
    usdc_mint_address: str,
) -> str:
    """Transfer USDC on Solana and return a base64-encoded payment proof.

    Returns the value to set as the X-Payment header.
    """
    payer = wallet.keypair
    recipient = Pubkey.from_string(recipient_address)
    usdc_mint = Pubkey.from_string(usdc_mint_address)
    amount_lamports = int(amount_usdc * (10**USDC_DECIMALS))

    # Derive associated token accounts
    sender_ata = wallet._get_associated_token_address(payer.pubkey(), usdc_mint)
    recipient_ata = wallet._get_associated_token_address(recipient, usdc_mint)

    # Build transfer instruction
    ix = transfer_checked(
        TransferCheckedParams(
            program_id=TOKEN_PROGRAM_ID,
            source=sender_ata,
            mint=usdc_mint,
            dest=recipient_ata,
            owner=payer.pubkey(),
            amount=amount_lamports,
            decimals=USDC_DECIMALS,
        )
    )

    # Build, sign, and send transaction
    async with AsyncClient(wallet.rpc_url) as client:
        recent_blockhash_resp = await client.get_latest_blockhash(Confirmed)
        blockhash = recent_blockhash_resp.value.blockhash

        msg = Message.new_with_blockhash([ix], payer.pubkey(), blockhash)
        tx = Transaction.new_unsigned(msg)
        tx.sign([payer], blockhash)

        result = await client.send_transaction(tx)
        tx_signature = str(result.value)

        # Wait for confirmation
        await client.confirm_transaction(result.value, Confirmed)

    # Construct proof
    proof = {
        "tx_signature": tx_signature,
        "payer": str(payer.pubkey()),
        "amount_usdc": str(amount_usdc),
    }
    return base64.b64encode(json.dumps(proof).encode()).decode()
