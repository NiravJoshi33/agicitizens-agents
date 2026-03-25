/**
 * mna/wallet.ts — Solana wallet and registration helpers.
 *
 * Handles keypair generation/loading, challenge signing,
 * USDC faucet, and payment signing for agent registration.
 * Reads all payment info from the platform API — nothing hardcoded.
 */

import {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  getAccount,
} from "@solana/spl-token";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import nacl from "tweetnacl";

// ── Keypair Management ──────────────────────────────────────

export function loadOrCreateKeypair(path: string): Keypair {
  if (existsSync(path)) {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    console.log(`   ✓ Loaded keypair from ${path}`);
    return Keypair.fromSecretKey(Uint8Array.from(data));
  }

  // Create directory if needed
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const keypair = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)));
  console.log(`   ✓ Generated new keypair → ${path}`);
  console.log(`   Wallet: ${keypair.publicKey.toBase58()}`);
  return keypair;
}

// ── Platform API Helpers ────────────────────────────────────

interface PaymentInfo {
  amount: number;
  mint: string;
  recipient: string;
  recipientIsAta: boolean;
  currency: string;
}

export async function fetchPaymentInfo(platformApi: string): Promise<PaymentInfo> {
  const res = await fetch(`${platformApi}/payments/info`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Failed to get payment info: ${res.status}`);
  const data = (await res.json()) as any;
  return {
    amount: data.amount ?? data.amountUsdc ?? 1,
    mint: data.mint ?? data.usdcMint ?? data.mintAddress,
    recipient: data.recipient ?? data.recipientAta ?? data.recipientAddress,
    recipientIsAta: data.recipientIsAta ?? true,
    currency: data.currency ?? "USDC",
  };
}

// ── Wallet Auth (Challenge-Response) ────────────────────────

export async function walletAuth(
  platformApi: string,
  keypair: Keypair,
): Promise<string> {
  // Step 1: Get challenge
  const challengeRes = await fetch(`${platformApi}/auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: keypair.publicKey.toBase58() }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!challengeRes.ok) {
    const text = await challengeRes.text();
    throw new Error(`Challenge failed (${challengeRes.status}): ${text.slice(0, 200)}`);
  }

  const challengeData = (await challengeRes.json()) as any;
  const challenge = challengeData.challenge ?? challengeData.message ?? challengeData.nonce;

  if (!challenge) throw new Error("No challenge received from platform");

  // Step 2: Sign challenge using ed25519
  const messageBytes = new TextEncoder().encode(challenge);
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
  const signatureBase64 = Buffer.from(signature).toString("base64");

  // Step 3: Verify signature → get API key
  const verifyRes = await fetch(`${platformApi}/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallet: keypair.publicKey.toBase58(),
      signature: signatureBase64,
      challenge,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!verifyRes.ok) {
    const text = await verifyRes.text();
    throw new Error(`Verify failed (${verifyRes.status}): ${text.slice(0, 200)}`);
  }

  const verifyData = (await verifyRes.json()) as any;
  const apiKey = verifyData.apiKey ?? verifyData.api_key ?? verifyData.token;

  if (!apiKey) throw new Error("No API key received from verify response");

  return apiKey;
}

// ── Faucet (devnet USDC) ────────────────────────────────────

export async function requestFaucet(
  platformApi: string,
  wallet: string,
  apiKey?: string,
): Promise<boolean> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${platformApi}/faucet`, {
    method: "POST",
    headers,
    body: JSON.stringify({ wallet }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    console.warn(`   ⚠ Faucet request failed (${res.status}): ${text.slice(0, 150)}`);
    return false;
  }

  console.log(`   ✓ Faucet: received devnet USDC`);
  return true;
}

// ── Sign Payment Transaction ────────────────────────────────

export async function signPaymentTransaction(
  keypair: Keypair,
  paymentInfo: PaymentInfo,
  rpcUrl: string,
): Promise<string> {
  const connection = new Connection(rpcUrl, "confirmed");
  const mint = new PublicKey(paymentInfo.mint);
  const payer = keypair.publicKey;

  // Get payer's USDC ATA
  const payerAta = await getAssociatedTokenAddress(mint, payer);

  // Determine recipient ATA
  let recipientAta: PublicKey;
  if (paymentInfo.recipientIsAta) {
    recipientAta = new PublicKey(paymentInfo.recipient);
  } else {
    recipientAta = await getAssociatedTokenAddress(
      mint,
      new PublicKey(paymentInfo.recipient),
    );
  }

  // Amount in base units (USDC has 6 decimals)
  const amountBaseUnits = Math.round(paymentInfo.amount * 1_000_000);

  // Check if payer ATA exists
  try {
    await getAccount(connection, payerAta);
  } catch {
    throw new Error(
      `No USDC token account found for wallet ${payer.toBase58()}. ` +
      `Request faucet USDC first.`,
    );
  }

  // Build transaction
  const transaction = new Transaction();

  // Add transfer instruction
  transaction.add(
    createTransferInstruction(
      payerAta,
      recipientAta,
      payer,
      amountBaseUnits,
    ),
  );

  // Set recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = payer;

  // Sign
  transaction.sign(keypair);

  // Serialize to base64
  const serialized = transaction.serialize();
  return Buffer.from(serialized).toString("base64");
}

// ── Full Agent Registration ─────────────────────────────────

export interface AgentRegistrationConfig {
  name: string;
  categories: string[];
  description: string;
  basePrice: string;
}

export async function registerAgent(
  platformApi: string,
  keypair: Keypair,
  rpcUrl: string,
  agentConfig: AgentRegistrationConfig,
): Promise<string> {
  const wallet = keypair.publicKey.toBase58();

  // Step 1: Check name availability
  console.log(`   [1/5] Checking name availability: "${agentConfig.name}"...`);
  const checkRes = await fetch(`${platformApi}/agents/check-availability`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: agentConfig.name, wallet }),
    signal: AbortSignal.timeout(15_000),
  });
  const checkData = (await checkRes.json()) as any;
  if (!checkRes.ok) {
    throw new Error(`Name check failed: ${JSON.stringify(checkData).slice(0, 200)}`);
  }
  console.log(`   ✓ Name "${agentConfig.name}" is available`);

  // Step 2: Get payment info from platform (dynamic, not hardcoded)
  console.log(`   [2/5] Fetching payment info...`);
  const paymentInfo = await fetchPaymentInfo(platformApi);
  console.log(`   ✓ Payment: ${paymentInfo.amount} ${paymentInfo.currency} to ${paymentInfo.recipient.slice(0, 12)}...`);

  // Step 3: Request faucet for devnet USDC
  console.log(`   [3/5] Requesting faucet USDC...`);
  await requestFaucet(platformApi, wallet);

  // Wait for faucet to settle
  await new Promise((r) => setTimeout(r, 3000));

  // Step 4: Sign payment transaction
  console.log(`   [4/5] Signing payment transaction...`);
  const signedTx = await signPaymentTransaction(keypair, paymentInfo, rpcUrl);
  console.log(`   ✓ Transaction signed (${signedTx.length} chars)`);

  // Step 5: Register with signed payment
  console.log(`   [5/5] Registering agent...`);
  const registerRes = await fetch(`${platformApi}/agents/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-payment": signedTx,
    },
    body: JSON.stringify({
      name: agentConfig.name,
      wallet,
      categories: agentConfig.categories,
      description: agentConfig.description,
      basePrice: agentConfig.basePrice,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const registerData = (await registerRes.json()) as any;

  if (!registerRes.ok) {
    throw new Error(
      `Registration failed (${registerRes.status}): ${JSON.stringify(registerData).slice(0, 300)}`,
    );
  }

  const apiKey = registerData.apiKey ?? registerData.api_key;
  if (!apiKey) {
    throw new Error(`Registration succeeded but no API key in response: ${JSON.stringify(registerData).slice(0, 200)}`);
  }

  console.log(`   ✓ Registered! API key: ${apiKey.slice(0, 12)}...`);
  return apiKey;
}
