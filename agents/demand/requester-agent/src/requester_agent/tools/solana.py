"""Generic Solana transaction tool — SPL USDC transfers via solders + solana-py."""

from __future__ import annotations

import json
import logging
from base64 import b64encode
from dataclasses import dataclass
from pathlib import Path

from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solders.hash import Hash as SolHash  # noqa: N811
from solders.keypair import Keypair
from solders.message import Message
from solders.pubkey import Pubkey
from solders.system_program import TransferParams, transfer
from solders.transaction import Transaction
from spl.token.constants import TOKEN_PROGRAM_ID
from spl.token.instructions import (
    TransferParams as SplTransferParams,
    create_associated_token_account,
    get_associated_token_address,
    transfer as spl_transfer,
)

from requester_agent.config import settings

logger = logging.getLogger(__name__)


@dataclass
class TransferResult:
    tx_signature: str
    confirmed: bool
    error: str | None = None


def load_keypair(path: str | None = None) -> Keypair:
    """Load or generate a Solana Ed25519 keypair from a JSON file."""
    kp_path = Path(path or settings.solana_keypair_path)
    if kp_path.exists():
        data = json.loads(kp_path.read_text())
        return Keypair.from_bytes(bytes(data))
    kp = Keypair()
    kp_path.parent.mkdir(parents=True, exist_ok=True)
    kp_path.write_text(json.dumps(list(bytes(kp))))
    logger.info("Generated new keypair at %s", kp_path)
    return kp


async def get_usdc_balance(pubkey: str, rpc_url: str | None = None) -> int:
    """Return USDC balance in base units for a given public key."""
    rpc = rpc_url or settings.solana_rpc_url
    mint = Pubkey.from_string(settings.usdc_mint_address)
    owner = Pubkey.from_string(pubkey)
    ata = get_associated_token_address(owner, mint)
    async with AsyncClient(rpc) as client:
        resp = await client.get_token_account_balance(ata)
        if resp.value is None:
            return 0
        return int(resp.value.amount)


async def get_sol_balance(pubkey: str, rpc_url: str | None = None) -> int:
    """Return SOL balance in lamports."""
    rpc = rpc_url or settings.solana_rpc_url
    pk = Pubkey.from_string(pubkey)
    async with AsyncClient(rpc) as client:
        resp = await client.get_balance(pk)
        return resp.value


async def solana_transfer(
    from_keypair: Keypair,
    to_address: str,
    amount: int,
    rpc_url: str | None = None,
    mint: str | None = None,
    create_ata_if_missing: bool = True,
) -> TransferResult:
    """Transfer SPL USDC from agent wallet to a target address.

    Returns a TransferResult with tx_signature and confirmation status.
    """
    rpc = rpc_url or settings.solana_rpc_url
    usdc_mint = Pubkey.from_string(mint or settings.usdc_mint_address)
    recipient = Pubkey.from_string(to_address)
    sender = from_keypair.pubkey()

    sender_ata = get_associated_token_address(sender, usdc_mint)
    recipient_ata = get_associated_token_address(recipient, usdc_mint)

    async with AsyncClient(rpc) as client:
        instructions = []

        # Create recipient ATA if missing
        if create_ata_if_missing:
            ata_info = await client.get_account_info(recipient_ata)
            if ata_info.value is None:
                ix = create_associated_token_account(sender, recipient, usdc_mint)
                instructions.append(ix)

        # SPL transfer instruction
        transfer_ix = spl_transfer(
            SplTransferParams(
                program_id=TOKEN_PROGRAM_ID,
                source=sender_ata,
                dest=recipient_ata,
                owner=sender,
                amount=amount,
            )
        )
        instructions.append(transfer_ix)

        # Build, sign, send
        recent = await client.get_latest_blockhash()
        blockhash = recent.value.blockhash

        msg = Message.new_with_blockhash(instructions, sender, blockhash)
        tx = Transaction.new_unsigned(msg)
        tx.sign([from_keypair], blockhash)

        try:
            result = await client.send_transaction(tx)
            sig = str(result.value)

            # Wait for confirmation
            await client.confirm_transaction(sig, commitment=Confirmed)
            return TransferResult(tx_signature=sig, confirmed=True)
        except Exception as exc:
            logger.error("Solana transfer failed: %s", exc)
            return TransferResult(tx_signature="", confirmed=False, error=str(exc))


def encode_payment_proof(tx_signature: str, payer: str, amount_usdc: float) -> str:
    """Encode a payment proof as base64 JSON for the X-Payment header."""
    proof = {
        "tx_signature": tx_signature,
        "payer": payer,
        "amount_usdc": amount_usdc,
    }
    return b64encode(json.dumps(proof).encode()).decode()
