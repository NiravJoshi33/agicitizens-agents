# M&A Agent

## What this agent does

A user sends a query → must pay 1 SOL → agent verifies payment on Solana → queries 200 real business listings → LLM generates a research report → returns JSON result.

---

## Step 1 — Start Surfpool (Local Solana Blockchain)

```bash
surfpool start
```

**Why:** The agent verifies payments on-chain. Surfpool is your local Solana blockchain. Without it, payment verification fails.

Leave this running in its own terminal.

---

## Step 2 — Start the M&A Agent

```bash

npm start
```

**Why:** This boots the agent — opens the vault DB, starts the HTTP server on port 3200, and begins the heartbeat loop.

You should see:

```
[M&A Agent] M&A Agent — SMBmarket Research
[M&A Agent] ====================================
[M&A Agent] Vault Online. Program ID: Au6NovuciU92yG7tJf7ZwkXc3zazAGY7GepbuJ3vtPMt
[M&A Agent] Server running on port 3200
  POST http://localhost:3200/query
  POST http://localhost:3200/webhook
  GET  http://localhost:3200/health
```

> The `Heartbeat failed` errors are **normal** — ignore them (AGICitizens platform not running in standalone mode).

Leave this running in its own terminal.

---

## Step 3 — Health Check

```bash
curl http://127.0.0.1:3200/health
```

**Why:** Confirm the server is alive before testing.

Expected response:

```json
{ "status": "ok", "agent": "mna-agent", "vault": "online" }
```

---

## Step 4 — Query Without Payment (Test 402)

```bash
curl -s -X POST http://127.0.0.1:3200/query \
  -H "Content-Type: application/json" \
  -d '{"query": "Find HVAC businesses"}' | python3 -m json.tool
```

**Why:** Confirms the payment gate works. You should get a 402 with payment instructions — NOT the actual data.

Expected response:

```json
{
  "protocol": "z492",
  "status": 402,
  "payment_details": {
    "recipient": "9AVpnkczvuLoDe7WLyUC5vYVhhBQHmcuJg2s49gSctFh",
    "amount": 1,
    "currency": "SOL",
    "memo": "M&A Research Fee — SMBmarket"
  },
  "message": "Pay 1 SOL to the recipient address, then re-submit with your tx_signature."
}
```

---

## Step 5 — Create a User Wallet & Pay 1 SOL

```bash
# Create a separate wallet (simulates a user paying the agent)
solana-keygen new --no-bip39-passphrase --outfile /tmp/test_user.json --force

# Give it 5 SOL from localnet
solana airdrop 5 $(solana-keygen pubkey /tmp/test_user.json)

# Pay 1 SOL to the agent wallet
solana transfer 9AVpnkczvuLoDe7WLyUC5vYVhhBQHmcuJg2s49gSctFh 1 \
  --keypair /tmp/test_user.json --allow-unfunded-recipient
```

**Why:** We need a SEPARATE wallet to pay from. Your main wallet IS the agent wallet — paying yourself gives a net 0 SOL change, which fails verification. The transfer command prints a **tx signature** — copy it.

You will see something like:

```
Signature: 3iTFXvTH4vLYk4m17yAMWUVN7mwdRvdJoZzoxMsNwxj7Y2xEmrxMVBhz58qfookHDi1jUR3nCP3ZfNibTamNZU1i
```

---

## Step 6 — Query With Payment (Full Flow)

Replace `YOUR_TX_SIGNATURE` with the signature from Step 5:

```bash
curl -s -X POST http://127.0.0.1:3200/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "HVAC businesses",
    "filters": {
      "industry_keywords": "hvac",
      "min_ebitda": 100000
    },
    "tx_signature": "YOUR_TX_SIGNATURE"
  }' | python3 -m json.tool
```

**Why:** Agent verifies the tx on-chain → confirms 1 SOL was received → queries vault → LLM writes research report → returns deals.

Expected response:

```json
{
  "status": 200,
  "output": {
    "summary": "Deal 1: This HVAC business shows strong fundamentals with $212K EBITDA...",
    "deals": [
      {
        "id": 3,
        "description": "The sale price of this HVAC business includes...",
        "annual_revenue": 817000,
        "ebitda": 212000,
        "asking_price": 250000,
        "sde": 195000
      }
    ]
  },
  "output_hash": "a1b2c3d4e5f6..."
}
```

---

## Troubleshooting

| Problem                      | Fix                                                                        |
| ---------------------------- | -------------------------------------------------------------------------- |
| `curl` hangs on health check | Use `127.0.0.1` not `localhost`                                            |
| `Payment not verified`       | Make sure you used a SEPARATE wallet (Step 5), not the agent wallet itself |
| `EADDRINUSE: port 3200`      | Run `kill $(lsof -ti :3200)` then restart                                  |
| `Heartbeat failed` errors    | Normal in standalone mode — ignore                                         |
| Vault shows 0 deals          | Run `npx tsx scripts/build-vault.ts` to rebuild                            |
| OpenRouter error             | Check `OPENROUTER_API_KEY` in `.env`                                       |
