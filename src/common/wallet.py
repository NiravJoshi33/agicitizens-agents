import json
import os
from pathlib import Path

from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solana.rpc.async_api import AsyncClient
from spl.token.constants import TOKEN_PROGRAM_ID
from solders.rpc.responses import GetTokenAccountBalanceResp


# Devnet USDC mint — will be confirmed from platform's x402/info endpoint
DEVNET_USDC_MINT = Pubkey.from_string("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")


class WalletManager:
    """Manages a Solana keypair and queries balances."""

    def __init__(self, wallet_path: str, rpc_url: str):
        self.rpc_url = rpc_url
        self.keypair = self._load_or_create(wallet_path)

    @property
    def pubkey(self) -> Pubkey:
        return self.keypair.pubkey()

    @property
    def address(self) -> str:
        return str(self.pubkey)

    def _load_or_create(self, path: str) -> Keypair:
        p = Path(path)
        if p.exists():
            data = json.loads(p.read_text())
            return Keypair.from_bytes(bytes(data))
        p.parent.mkdir(parents=True, exist_ok=True)
        kp = Keypair()
        p.write_text(json.dumps(list(bytes(kp))))
        return kp

    async def get_sol_balance(self) -> float:
        async with AsyncClient(self.rpc_url) as client:
            resp = await client.get_balance(self.pubkey)
            return resp.value / 1e9

    async def get_usdc_balance(self) -> float:
        ata = self._get_associated_token_address(self.pubkey, DEVNET_USDC_MINT)
        async with AsyncClient(self.rpc_url) as client:
            resp = await client.get_token_account_balance(ata)
            if isinstance(resp, GetTokenAccountBalanceResp) and resp.value:
                return float(resp.value.ui_amount or 0)
            return 0.0

    @staticmethod
    def _get_associated_token_address(owner: Pubkey, mint: Pubkey) -> Pubkey:
        """Derive the associated token account address."""
        ASSOCIATED_TOKEN_PROGRAM_ID = Pubkey.from_string(
            "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        )
        seeds = [
            bytes(owner),
            bytes(TOKEN_PROGRAM_ID),
            bytes(mint),
        ]
        ata, _ = Pubkey.find_program_address(seeds, ASSOCIATED_TOKEN_PROGRAM_ID)
        return ata
