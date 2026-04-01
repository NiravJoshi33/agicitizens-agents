/**
 * solana.ts — Solana wallet + SPL USDC payment signing for AGICitizens registration.
 *
 * Handles:
 *   - Loading Ed25519 keypair from env (JSON byte array)
 *   - Getting faucet USDC
 *   - Signing SPL token transfer transactions (x-payment header)
 *   - Challenge-response auth (Ed25519 message signing)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import nacl from "tweetnacl";
// @ts-ignore — no type declarations for bs58
import bs58 from "bs58";

// ── Config ──────────────────────────────────────────────────

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const USDC_MINT = process.env.USDC_MINT;

// ── Load Keypair ────────────────────────────────────────────

export function loadKeypairFromEnv(): Keypair | null {
  const raw = process.env.AGENT_WALLET_KEYPAIR;
  if (!raw) return null;
  try {
    const bytes = JSON.parse(raw);
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch (err: any) {
    console.error(`Failed to parse AGENT_WALLET_KEYPAIR: ${err.message}`);
    return null;
  }
}

// ── Get Connection ──────────────────────────────────────────

export function getConnection(): Connection {
  return new Connection(SOLANA_RPC_URL, "confirmed");
}

// ── Request Faucet USDC ─────────────────────────────────────

export async function requestFaucet(
  wallet: string,
  platformApiUrl: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${platformApiUrl}/faucet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      return { ok: true, message: `Faucet funded: ${JSON.stringify(data)}` };
    }
    return { ok: false, message: `Faucet error (${res.status}): ${JSON.stringify(data)}` };
  } catch (err: any) {
    return { ok: false, message: `Faucet request failed: ${err.message}` };
  }
}

// ── Sign USDC Payment (for x-payment header) ───────────────

export async function signPayment(
  keypair: Keypair,
  recipientAddress: string,
  amountBaseUnits: number,
  recipientIsAta: boolean = true,
  mintAddress?: string,
): Promise<{ xPayment: string; error?: string }> {
  try {
    const connection = getConnection();
    const mintPubkey = mintAddress ?? USDC_MINT;
    if (!mintPubkey) {
      return { xPayment: "", error: "No USDC mint address provided or configured in env" };
    }
    const mint = new PublicKey(mintPubkey);
    const sender = keypair.publicKey;

    // Derive sender's ATA
    const senderAta = getAssociatedTokenAddressSync(mint, sender);

    // Determine recipient token account
    let recipientAta: PublicKey;
    if (recipientIsAta) {
      recipientAta = new PublicKey(recipientAddress);
    } else {
      recipientAta = getAssociatedTokenAddressSync(mint, new PublicKey(recipientAddress));
    }

    // Build transfer instruction
    const transferIx = createTransferInstruction(
      senderAta,
      recipientAta,
      sender,
      amountBaseUnits,
      [],
      TOKEN_PROGRAM_ID,
    );

    // Build transaction
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = sender;

    // Check if sender ATA exists, create if not
    try {
      await getAccount(connection, senderAta);
    } catch {
      tx.add(
        createAssociatedTokenAccountInstruction(
          sender,
          senderAta,
          sender,
          mint,
        ),
      );
    }

    tx.add(transferIx);

    // Sign WITHOUT submitting
    tx.sign(keypair);

    // Serialize to base64
    const serialized = tx.serialize();
    const xPayment = Buffer.from(serialized).toString("base64");

    return { xPayment };
  } catch (err: any) {
    return { xPayment: "", error: `Payment signing failed: ${err.message}` };
  }
}

// ── Sign Message (for challenge-response auth) ──────────────

export function signMessage(keypair: Keypair, message: string): string {
  const messageBytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
  return bs58.encode(Buffer.from(signature));
}

// ── Get Balances ────────────────────────────────────────────

export async function getBalances(wallet: PublicKey): Promise<{ sol: number; usdc: number }> {
  const connection = getConnection();

  let sol = 0;
  try {
    const balance = await connection.getBalance(wallet);
    sol = balance / 1e9; // lamports → SOL
  } catch {}

  let usdc = 0;
  if (USDC_MINT) {
    try {
      const mint = new PublicKey(USDC_MINT);
      const ata = getAssociatedTokenAddressSync(mint, wallet);
      const account = await getAccount(connection, ata);
      usdc = Number(account.amount) / 1e6; // base units → USDC
    } catch {}
  }

  return { sol, usdc };
}
