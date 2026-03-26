import {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
  getAccount,
} from "@solana/spl-token";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function loadOrCreateKeypair(path: string): Keypair {
  if (existsSync(path)) {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    console.log(`   ✓ Keypair loaded`);
    return Keypair.fromSecretKey(Uint8Array.from(data));
  }

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const keypair = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)));
  console.log(`   ✓ Generated new keypair → ${path}`);
  console.log(`   Wallet: ${keypair.publicKey.toBase58()}`);
  return keypair;
}

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

  console.log(`   [1/5] Requesting devnet USDC from faucet...`);
  const faucetRes = await fetch(`${platformApi}/faucet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet }),
    signal: AbortSignal.timeout(30_000),
  });
  if (faucetRes.ok) {
    const faucetData = (await faucetRes.json()) as any;
    console.log(`   ✓ Faucet: ${faucetData.usdc ?? "USDC received"}`);
  } else {
    const text = await faucetRes.text();
    console.warn(`   ⚠ Faucet failed (${faucetRes.status}): ${text.slice(0, 150)}`);
    console.log(`   Continuing — wallet may already have USDC`);
  }

  await new Promise((r) => setTimeout(r, 3000));

  console.log(`   [2/5] Checking name availability: "${agentConfig.name}"...`);
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
  if (!checkData.available) {
    throw new Error(
      `Name "${agentConfig.name}" not available. ` +
      `nameTaken: ${checkData.nameTaken}, walletTaken: ${checkData.walletTaken}`,
    );
  }
  console.log(`   ✓ Name "${agentConfig.name}" is available`);

  console.log(`   [3/5] Fetching payment info...`);
  const payInfoRes = await fetch(`${platformApi}/payments/info`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!payInfoRes.ok) {
    throw new Error(`Failed to get payment info: ${payInfoRes.status}`);
  }
  const payInfo = (await payInfoRes.json()) as any;
  const amount = Number(payInfo.amount ?? 1);
  const mint = payInfo.mint;
  const recipient = payInfo.recipient;
  console.log(`   ✓ Payment: ${amount} ${payInfo.currency ?? "USDC"} → ${recipient.slice(0, 12)}...`);

  console.log(`   [4/5] Signing USDC transfer transaction...`);
  const connection = new Connection(rpcUrl, "confirmed");
  const mintPubkey = new PublicKey(mint);

  const payerAta = await getAssociatedTokenAddress(mintPubkey, keypair.publicKey);

  const recipientAta = new PublicKey(recipient);

  const amountBaseUnits = Math.round(amount * 1_000_000);

  try {
    const account = await getAccount(connection, payerAta);
    console.log(`   Balance: ${Number(account.amount) / 1_000_000} USDC`);
  } catch {
    throw new Error(
      `No USDC token account for wallet ${wallet}. Faucet may not have confirmed yet.`,
    );
  }

  const tx = new Transaction();
  tx.add(
    createTransferCheckedInstruction(payerAta, mintPubkey, recipientAta, keypair.publicKey, amountBaseUnits, 6),
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = keypair.publicKey;

  tx.sign(keypair);

  const signedTxBase64 = Buffer.from(tx.serialize()).toString("base64");
  console.log(`   ✓ Transaction signed`);

  console.log(`   [5/5] Registering agent...`);
  const registerRes = await fetch(`${platformApi}/agents/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-payment": signedTxBase64,
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
    throw new Error(
      `Registration succeeded but no API key in response: ${JSON.stringify(registerData).slice(0, 200)}`,
    );
  }

  console.log(`   ✓ Registered! API key: ${apiKey.slice(0, 16)}...`);
  console.log(`   ⚠ SAVE THIS KEY — it is shown once and cannot be recovered.`);
  return apiKey;
}
