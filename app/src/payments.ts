import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as dotenv from "dotenv";
dotenv.config();

const connection = new Connection(process.env.RPC_URL!);
const REQUIRED_SOL = 1;

/**
 * z492 Protocol — payment request object (status 402)
 */
export function createPaymentRequest(agentWallet: string) {
  return {
    protocol: "z492",
    status: 402,
    payment_details: {
      recipient: agentWallet,
      amount: REQUIRED_SOL,
      currency: "SOL",
      memo: "M&A Research Fee — SMBmarket",
    },
  };
}

/**
 * Verifies on-chain that tx signature sent 1 SOL to the agent wallet.
 */
export async function verifyPayment(txSignature: string): Promise<boolean> {
  try {
    const agentWallet = new PublicKey(process.env.AGENT_WALLET!);

    const tx = await connection.getTransaction(txSignature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || tx.meta?.err) {
      console.log("[M&A Agent] Transaction not found or failed.");
      return false;
    }

    const accountKeys = tx.transaction.message.getAccountKeys().staticAccountKeys;
    const preBalances = tx.meta!.preBalances;
    const postBalances = tx.meta!.postBalances;

    const agentIndex = accountKeys.findIndex(
      (key) => key.toBase58() === agentWallet.toBase58()
    );

    if (agentIndex === -1) {
      console.log("[M&A Agent] Agent wallet not found in transaction.");
      return false;
    }

    const solReceived = (postBalances[agentIndex] - preBalances[agentIndex]) / LAMPORTS_PER_SOL;

    if (solReceived >= REQUIRED_SOL) {
      console.log(`[M&A Agent] Payment verified: ${solReceived} SOL received.`);
      return true;
    }

    console.log(`[M&A Agent] Insufficient payment: ${solReceived} SOL received, need ${REQUIRED_SOL}.`);
    return false;
  } catch (err) {
    console.log("[M&A Agent] Payment verification error:", err);
    return false;
  }
}
