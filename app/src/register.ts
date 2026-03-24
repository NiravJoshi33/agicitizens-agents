/**
 * Register the M&A agent on the AGICitizens platform.
 *
 * Usage:
 *   npm run register
 *
 * Prerequisites:
 *   1. AGICitizens API must be running (AGICITIZENS_API_URL in .env)
 *   2. Faucet must be running (to get USDC for registration fee)
 *   3. AGENT_SECRET_KEY must point to a valid Solana keypair JSON file
 *
 * What it does:
 *   1. Loads your Solana keypair
 *   2. Requests SOL + USDC from the faucet
 *   3. Registers the agent (pays 1 USDC registration fee)
 *   4. Prints the API key — add it to .env as MNA_AGENT_API_KEY
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
dotenv.config();

async function main() {
  const { Keypair, VersionedTransaction, Connection, PublicKey } = await import("@solana/web3.js");
  const { getAssociatedTokenAddressSync, createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction } = await import("@solana/spl-token");
  const { TransactionMessage } = await import("@solana/web3.js");

  const BASE_URL = process.env.AGICITIZENS_API_URL;
  if (!BASE_URL) {
    console.error("ERROR: AGICITIZENS_API_URL not set in .env");
    process.exit(1);
  }

  // Load keypair
  const keypairPath = (process.env.AGENT_SECRET_KEY || "~/.config/solana/id.json").replace("~", process.env.HOME || "");
  if (!fs.existsSync(keypairPath)) {
    console.error(`ERROR: Keypair file not found at ${keypairPath}`);
    console.error("Run: solana-keygen new -o ~/.config/solana/id.json");
    process.exit(1);
  }

  const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  const wallet = keypair.publicKey.toBase58();

  console.log("\n[M&A Agent] Registration");
  console.log("============================");
  console.log(`  Wallet:   ${wallet}`);
  console.log(`  Platform: ${BASE_URL}`);

  // Step 1: Request faucet
  const faucetBase = BASE_URL.replace("/v1", "").replace(":3099", ":3101");
  console.log(`\n  Requesting SOL + USDC from faucet (${faucetBase})...`);

  try {
    const faucetRes = await fetch(`${faucetBase}/faucet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet }),
    });
    const faucetData = await faucetRes.json() as any;
    console.log(`  Got ${faucetData.dispensed?.solAmount} SOL + ${faucetData.dispensed?.tokenAmount} USDC`);
  } catch (err) {
    console.log("  Faucet request failed (may already have funds, continuing...)");
  }

  // Wait for faucet tx to confirm
  await new Promise((r) => setTimeout(r, 2000));

  // Step 2: Check if already registered
  console.log("\n  Checking if agent is already registered...");
  const checkRes = await fetch(`${BASE_URL}/agents/mna-agent`);
  if (checkRes.ok) {
    const existing = await checkRes.json() as any;
    if (existing.name || existing.data?.name) {
      console.log("  Agent 'mna-agent' is already registered!");
      console.log("  Use wallet auth to recover your API key:");
      console.log("  → The agent will authenticate via wallet signature on startup");
      process.exit(0);
    }
  }

  // Step 3: Get payment info
  console.log("  Getting registration payment info...");
  const paymentRes = await fetch(`${BASE_URL}/payments/info`);
  const paymentInfo = await paymentRes.json() as any;
  const info = paymentInfo.data || paymentInfo;
  console.log(`  Registration fee: ${info.amount} ${info.currency}`);

  // Step 4: Build USDC payment transaction
  const connection = new Connection(process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899", "confirmed");
  const usdcMint = new PublicKey(info.mint);
  const recipientAta = new PublicKey(info.recipient);
  const amountU64 = Math.round(parseFloat(info.amount) * 1_000_000);
  const payerAta = getAssociatedTokenAddressSync(usdcMint, keypair.publicKey);

  // Derive server wallet from recipient ATA (need to find the owner)
  // We'll create the ATA idempotently — the server wallet is the owner
  const accInfo = await connection.getAccountInfo(recipientAta);
  let serverWallet: InstanceType<typeof PublicKey>;

  if (accInfo) {
    // ATA exists, parse owner from account data (bytes 32-64)
    serverWallet = new PublicKey(accInfo.data.subarray(32, 64));
  } else {
    // ATA doesn't exist yet — we need to know the server wallet
    // Try to derive from the keypair in env, or fallback
    console.error("ERROR: Server USDC ATA doesn't exist. Make sure the platform has run at least once.");
    process.exit(1);
  }

  const instructions = [
    createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, recipientAta, serverWallet, usdcMint),
    createTransferCheckedInstruction(payerAta, usdcMint, recipientAta, keypair.publicKey, amountU64, 6),
  ];

  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  tx.sign([keypair]);
  const signedTxBase64 = Buffer.from(tx.serialize()).toString("base64");

  // Step 5: Register with payment
  console.log("  Registering agent with USDC payment...");
  const registerRes = await fetch(`${BASE_URL}/agents/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-payment": signedTxBase64,
    },
    body: JSON.stringify({
      name: "mna-agent",
      wallet,
      categories: ["research", "analysis"],
      description:
        "M&A research agent specializing in deal sourcing, financial analysis, and acquisition research using SMBmarket data.",
      basePrice: "10.00",
    }),
  });

  const registerData = await registerRes.json() as any;

  if (!registerRes.ok) {
    console.error("\n[M&A Agent] Registration failed:", JSON.stringify(registerData, null, 2));
    process.exit(1);
  }

  const apiKey = registerData.apiKey;

  console.log("\n[M&A Agent] Agent registered successfully!");
  console.log("============================");
  console.log(`  Name:     mna-agent`);
  console.log(`  Wallet:   ${wallet}`);
  console.log(`  API Key:  ${apiKey}`);
  console.log("");
  console.log("  Add this to your .env file:");
  console.log(`     MNA_AGENT_API_KEY=${apiKey}`);
  console.log("");
  console.log("  Then start the agent:");
  console.log("     npm start");
}

main().catch((err) => {
  console.error("\n[M&A Agent] Registration error:", err.message);
  process.exit(1);
});
