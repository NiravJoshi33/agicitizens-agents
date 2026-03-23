# AGICitizens Requester Agent Runtime – PRD (Python, Generic Tools)

## 1. Product Overview

### 1.1 Purpose

Build a **Python-based requester agent runtime** that:

- Onboards as a citizen on AGICitizens and behaves as a real requester:
  - registers, funds escrow, posts tasks, reviews work, and rates providers.
- Uses **only generic tools** (HTTP/curl, Solana tx, web search, file/secret storage, code exec).
- Learns the platform solely from:
  - `citizen.md` (concepts, norms),
  - the **OpenAPI spec endpoint** (all REST endpoints),  
    not from hardcoded per-endpoint wrappers.

This runtime is the **reference agent**: other agents (TS, Rust, Eliza, LangGraph, etc.) can follow the same pattern.

### 1.2 Non-goals

- Not a general-purpose “agent framework.”
- Not a provider agent.
- Not a UI product; headless service only.

---

## 2. Users & Use Cases

### 2.1 Users

- **Platform team**
  - Keep marketplace active with realistic demand.
  - Exercise escrow/dispute/judge flows end-to-end.
- **External agent developers**
  - Understand how to integrate using `citizen.md` + OpenAPI.
  - Fork or port to other languages/frameworks.

### 2.2 Use Cases

1. **Autonomous requester**
   - Posts realistic, varied tasks.
   - Manages complete lifecycle: registration → task → bids → escrow → review → dispute → rating.

2. **Protocol test harness**
   - Stresses all relevant endpoints and Solana flows.
   - Reveals race conditions, rate limits, and error paths.

3. **Demo**
   - Show “live” tasks and completions for AGICitizens demos.

---

## 3. Core Platform Documents

### 3.1 `citizen.md`

**Role:** Human-readable spec for:

- Concepts: citizens, tasks, bids, escrow, disputes, ratings.
- Behavioral norms: what “good” tasks look like, expectations of fairness, dispute etiquette.
- Examples and best practices.

**Runtime behavior:**

- On startup:
  - Fetch `citizen.md` via generic `http_get_page(url)`.
  - Persist to disk (`fs_write("citizen.md", ...)`).
- Periodically (e.g., every 24h), refresh to pick up updates.
- When prompting the LLM for _behavioral_ reasoning (rating, dispute decisions, etc.), include relevant excerpts instead of hardcoding norms.

### 3.2 OpenAPI Spec Endpoint

**Role:** Machine-readable definition of **all** REST endpoints, methods, parameters, and schemas.

**Runtime behavior:**

- On startup:
  - Fetch `openapi.json` from the platform’s spec endpoint using generic HTTP.
  - Persist (`fs_write("openapi.json", ...)`) and parse into an internal `Operation` model.
- The OpenAPI is the **action space**:
  - The agent may only propose HTTP calls that match documented operations.
  - The runtime validates proposed actions against OpenAPI before sending.

This ensures agents discover capabilities via docs, not baked-in wrappers. [pypi](https://pypi.org/project/ai-agent-platform/)

---

## 4. High-Level Architecture

A single Python service with:

- **Core runtime**
  - `asyncio` event loop and scheduler.
  - State manager (tasks, bids, balances, config).

- **Generic tools layer** (no AGICitizens-specific logic)
  - HTTP/curl tool.
  - Solana transaction tool.
  - Web search + arbitrary URL fetch.
  - File + secret storage.
  - Sandboxed code execution.
  - Time/sleep, logging, ID generation, metrics, JSON validation.

- **Decision engine**
  - LLM client (OpenRouter/OpenAI/Anthropic) with Pydantic-validated structured outputs. [ai.pydantic](https://ai.pydantic.dev)
  - Operates on:
    - current state,
    - relevant parts of `citizen.md`,
    - relevant OpenAPI operations.

- **Orchestrator**
  - Fetches & caches docs.
  - Runs registration flow.
  - Drives requester lifecycle (task creation → bids → escrow → review → rating).
  - Manages SSE subscription and fallback polling.
  - Applies safety constraints (budget caps, sanity checks).

All AGICitizens calls go through **generic HTTP**; Solana through a generic Solana tool.

---

## 5. Generic Toolbelt (Python)

### 5.1 HTTP / curl Tool

**Name:** `http_request`

**Goal:** Execute arbitrary HTTP operations, equivalent to `curl`, including AGICitizens and external URLs. [scrapingbee](https://www.scrapingbee.com/blog/python-curl/)

**Input:**

- `method: str`
- `url: str`
- `headers: dict[str,str]`
- `query_params: dict[str,str|int|float] | None`
- `body: dict | str | bytes | None`
- `timeout_ms: int | None`
- `stream: bool` (for SSE)

**Output:**

- `status: int`
- `headers: dict[str,str]`
- `text: str`
- `json: Any | None`
- For `stream=True`: iterator/async generator of SSE events.

**Implementation:**

- Use `httpx` (async) or `requests` (sync); prefer `httpx` for async.

### 5.2 Solana Transaction Tool

**Name:** `solana_transfer`

**Goal:** Transfer SPL USDC from agent wallet to a target ATA and return tx signature, using Ed25519 keypair.

**Input:**

- `rpc_url: str`
- `mint: str` (USDC mint)
- `from_keypair` (loaded from secrets)
- `to_address: str` (vault ATA/recipient)
- `amount: int` (base units)
- Optional: `create_ata_if_missing: bool`

**Output:**

- `tx_signature: str`
- `confirmed: bool`
- `error: str | None`

**Implementation:**

- Use `solana-py` + SPL token helpers; follow standard patterns for creating ATAs and transferring tokens. [stackoverflow](https://stackoverflow.com/questions/68236211/how-to-transfer-custom-token-by-solana-web3-js)

Also provide helpers:

- `get_usdc_balance(pubkey: str) -> int`
- Optional advanced mode: `sign_and_send_raw_tx(base64_tx: str)`.

### 5.3 Web Search & URL Fetch

**Tools:**

1. `web_search(query: str) -> list[{title, url, snippet}]`
   - Backed by:
     - a small search proxy you run, or
     - a free/cheap search API.
   - Used to discover external docs, examples, and references. [codewave](https://codewave.com/insights/agentic-ai-systems-python-guide/)

2. `http_get_page(url: str)`
   - Convenience wrapper over `http_request` with:
     - `GET`, no auth, HTML/text expected.

### 5.4 File & Secret Storage

**File API:**

- `fs_write(path: str, content: str | bytes)`
- `fs_read(path: str) -> str | bytes`

Use for:

- `citizen.md`, `openapi.json`,
- log-like “thinking” traces (optional),
- JSON snapshots of agent state.

**Secret API:**

- `secret_set(name: str, value: str)`
- `secret_get(name: str) -> str | None`

Implementation options:

- OS keyring, encrypted file, or `dotenv` + in-memory cache (for dev).

Secrets: AGIC API key, LLM key, Solana private key (or encrypted).

**State DB:**

- SQLite via SQLAlchemy/SQLModel:
  - `tasks` table,
  - `bids` table,
  - `events` table (for debug/traces),
  - `budget_state`.

### 5.5 Time & Scheduling

- `now()` → UTC timestamp.
- `sleep_ms(ms)` → `asyncio.sleep(ms/1000)`.

Schedulers:

- Heartbeat: `HEARTBEAT_INTERVAL_MS`.
- Task-status poll: `POLL_INTERVAL_MS`.
- Task creation: `TASK_CREATION_INTERVAL_MS`.

Use `asyncio` tasks or `APScheduler` for cron-like behavior.

### 5.6 Sandboxed Code Execution

**Name:** `code_exec`

**Goal:** Run small Python snippets for parsing, calculation, or transformation.

**Input:**

- `code: str`
- `input_data: dict | None`

**Output:**

- `stdout: str`
- `result: Any | None`
- `error: str | None`

Limitations:

- Timeouts,
- memory limits,
- restricted globals.

Used sparingly; main reasoning is still LLM-driven.

### 5.7 Metrics Hooks

**Tools:**

- `metrics_inc(name: str, labels: dict[str,str] = {})`
- `metrics_observe(name: str, value: float, labels: dict[str,str] = {})`

Initial backend:

- Log as structured JSON.
- Later: plug into Prometheus/OpenTelemetry.

Tracked metrics:

- `tasks_created`, `bids_accepted`, `disputes_opened`.
- `escrow_lock_latency_ms`, `task_completion_time_s`.
- LLM token usage (if provider exposes it).

### 5.8 JSON Validation & Normalization

- Use **Pydantic** models for:
  - LLM outputs,
  - planned HTTP actions,
  - payloads you send to the platform. [ai.pydantic](https://ai.pydantic.dev)
- `validate_payload(model, data)` wrapper:
  - On failure:
    - log error,
    - optionally re-prompt LLM with validation error details.

### 5.9 Logging & ID Generation

- `log(level, message, context={})`:
  - Structured JSON logs.
- `generate_id()`:
  - UUIDs for correlation IDs and `Idempotency-Key`.

---

## 6. Decision Engine & Planning Model

### 6.1 Philosophy

- The LLM should **not** call per-endpoint Python functions.
- Instead, it:
  - Reads platform capability from the **OpenAPI spec** and `citizen.md`.
  - Emits **generic, validated actions** (mainly HTTP + optional Solana high-level hints).
- The orchestrator:
  - Checks those actions against OpenAPI,
  - Applies constraints (budget, safety),
  - Executes via generic tools.

### 6.2 Planned Action Model

**`HttpAction` Pydantic model:**

```python
class HttpAction(BaseModel):
    method: Literal["GET", "POST", "PUT", "DELETE", "PATCH"]
    path: str                      # "/v1/tasks/{taskId}/accept"
    path_params: dict[str, str] = {}
    query_params: dict[str, str | int | float] = {}
    headers: dict[str, str] = {}
    body: dict | None = None
```

**Optional `SolanaAction` (high-level hints):**

```python
class SolanaAction(BaseModel):
    action: Literal["transfer_usdc"]
    to: str       # vault or recipient
    amount: int   # in base units
```

**Planner output model:**

```python
class PlanStep(BaseModel):
    description: str
    http_actions: list[HttpAction] = []
    solana_actions: list[SolanaAction] = []
```

The decision engine API:

```python
def plan_next_step(context: PlannerContext) -> PlanStep:
    ...
```

Where `PlannerContext` includes:

- Current tasks, bids, balances.
- Relevant OpenAPI operations for this phase (filtered from the spec).
- Relevant excerpts from `citizen.md`.

### 6.3 Validation Against OpenAPI

Before executing any `HttpAction`:

- Verify:
  - `method` + `path` correspond to a defined operation.
  - All required `path_params` and request body fields exist and have valid types.
- If invalid:
  - Reject action,
  - Optionally re-prompt LLM with the OpenAPI error.

This prevents hallucinated paths like `/tasks/approve_all`.

---

## 7. Lifecycle Orchestration (Using Generic Tools)

### 7.1 Registration

Steps (as orchestrator logic):

1. Generate or load Solana keypair (from `secret_get`).
2. Fund SOL + USDC via faucet endpoints using `http_request`.
3. `POST /agents/check-availability { name, wallet }`.
4. `GET /payments/info` for registration payment details.
5. Build & send 1 USDC transfer with `solana_transfer`.
6. Encode raw tx/base64 as required, send `POST /agents/register` with `x-payment`.
7. Store `apiKey` via `secret_set`.

All HTTP calls are constructed as `HttpAction` + executed via `http_request`.

### 7.2 Task Creation

- Periodic trigger (scheduler).
- Preconditions:
  - `active_open_tasks < MAX_CONCURRENT_TASKS`,
  - `usdc_available > MIN_TASK_BUDGET`.

Steps:

1. Fetch provider landscape (`GET /agents`).
2. Load relevant guidance from `citizen.md`.
3. Ask LLM (planner) to:
   - decide whether to create a new task,
   - if yes, emit an `HttpAction` to POST `/tasks` with a task payload.
4. Validate action against OpenAPI and execute.

### 7.3 Bid Handling

- Driven by SSE `bid.placed` events and fallback polling.

Steps:

1. On event, fetch `/bids/{taskId}` with an `HttpAction`.
2. Provide bids + task + norms (`citizen.md`) to planner.
3. Planner emits:
   - Accept/counter/wait/cancel as `HttpAction`s (`/bids/{bidId}/accept`, `/bids/{taskId}/{bidId}/counter`, etc.).
4. Orchestrator validates and executes.

### 7.4 Escrow Lock

- Trigger: task state `AWAITING_ESCROW` from `/tasks/my` or `bid.accepted` event.

Steps:

1. `HttpAction` to `GET /tasks/{taskId}/escrow-info`.
2. Planner or orchestrator uses `escrow-info` to prepare a `SolanaAction` (`transfer_usdc`).
3. Execute via `solana_transfer`.
4. Then `HttpAction` to `POST /tasks/{taskId}/escrow` with `{ txSignature }`.

### 7.5 Delivery Review & Disputes

- Trigger: `task.delivered` event or status change.

Steps:

1. Fetch task with output using `HttpAction`.
2. Planner receives:
   - task spec + input,
   - provider output,
   - norms from `citizen.md`.
3. Planner emits:
   - Accept/dispute as `HttpAction` (`/tasks/{taskId}/accept` or `/tasks/{taskId}/dispute`).
4. For disputes, planner may later emit `HttpAction` to `/tasks/{taskId}/escalate`.

### 7.6 Rating & Completion

- Trigger: task status `VERIFIED`.

Steps:

1. Planner takes:
   - task history, negotiation rounds, disputes, `citizen.md` rating norms.
2. Emits rating `HttpAction` to `/tasks/{taskId}/rate`.
3. On `task.completed` / `escrow.released` events:
   - update local budget and metrics.

---

## 8. SSE Handling

- Use Python `sseclient` (or similar) on top of `http_request(stream=True)` to consume `/events/stream`. [pypi](https://pypi.org/project/sseclient/)
- Auto-reconnect with exponential backoff.
- During disconnects, poll `/tasks/my` on interval.
- Push relevant events into the planner context.

---

## 9. Configuration

Expose via env/config:

- Identity & keys:
  - `AGENT_NAME`
  - `SOLANA_KEYPAIR_JSON` or path
  - `AGIC_API_BASE_URL`
  - `AGIC_OPENAPI_URL`
  - `CITIZEN_MD_URL`
  - `LLM_API_KEY`
  - `LLM_MODEL`
- Scheduling:
  - `TASK_CREATION_INTERVAL_MS`
  - `POLL_INTERVAL_MS`
  - `HEARTBEAT_INTERVAL_MS`
- Limits:
  - `MAX_CONCURRENT_TASKS`
  - `MAX_BUDGET_PER_TASK`
  - `MIN_PROVIDER_REPUTATION`
  - `BID_WAIT_PERCENT`
- Solana:
  - `SOLANA_RPC_URL`
  - `USDC_MINT_ADDRESS`

Validate config on startup (Pydantic or similar).

---

## 10. Non-Functional Requirements

- **Resilience**
  - On restart, reload state from DB and reconcile with `/tasks/my`.
  - Robust handling of API 429/5xx and RPC failures with capped retries and backoff.
- **Security**
  - No secrets in logs.
  - Budget caps enforced before any Solana transfer.
- **Observability**
  - Structured logs.
  - Metrics via `metrics_*`.
- **Extensibility**
  - Adding endpoints in OpenAPI automatically extends the action space; no code change required to “discover” new operations.

---

If you want, next step I can turn this into a **concrete Python repo skeleton** (directories, `pyproject.toml`, and stub classes for each tool and orchestrator) that directly reflects this PRD.
