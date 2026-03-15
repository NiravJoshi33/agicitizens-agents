"""Research Agent — Raw Python + OpenRouter, no framework.

Given only PLATFORM_URL, this agent:
1. Fetches citizen.md and openapi.json
2. Uses its LLM to understand the API
3. Registers itself via X402 payment
4. Runs: heartbeat + task discovery/execution loop

Proves that zero framework overhead is needed to join the platform.
"""

import asyncio
import hashlib
import json
import logging
from pathlib import Path

import httpx

from src.common.config import AgentConfig
from src.common.events import EventEmitter
from src.common.wallet import WalletManager
from src.common import x402
from src.agents.research import llm

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DISCOVERY_PROMPT = """\
You are an AI agent reading platform documentation to understand how to operate on this platform.

Below are the platform docs (citizen.md) and the OpenAPI spec. Extract a JSON object with:
{
  "base_url": "the API base URL",
  "register_endpoint": "path for agent registration",
  "register_method": "HTTP method",
  "register_fields": ["list of required field names"],
  "auth_header": "header name for auth",
  "auth_prefix": "prefix before the token (e.g. Bearer aci_)",
  "heartbeat_endpoint": "path",
  "heartbeat_interval_seconds": 60,
  "list_tasks_endpoint": "path",
  "accept_task_endpoint_template": "path with {task_id} placeholder",
  "deliver_task_endpoint_template": "path with {task_id} placeholder",
  "task_statuses": {"open": "status value for open tasks"},
  "categories": ["list of valid categories"],
  "x402_info_endpoint": "path to get payment info",
  "x402_header_name": "header name for payment proof",
  "payment_required_for": ["list of actions needing payment, e.g. registration"]
}

Return ONLY the JSON object, no markdown fencing, no explanation.

--- CITIZEN.MD ---
{citizen_md}

--- OPENAPI SPEC ---
{openapi_spec}
"""

TASK_EVAL_PROMPT = """\
You are a research agent. Evaluate whether you should accept this task.
Your capabilities: summarization, synthesis, report generation.
Your category: research.

Task:
{task_json}

Reply with JSON: {{"accept": true/false, "reason": "brief reason"}}
Return ONLY JSON, no markdown.
"""

TASK_EXEC_PROMPT = """\
You are a research agent. Complete the following task by providing thorough research output.

Task input:
{task_input}

Produce a JSON response matching this structure:
{{
  "findings": "detailed research findings as a string",
  "sources": ["list of sources or reasoning steps"],
  "confidence": 0.0 to 1.0
}}

Return ONLY JSON, no markdown fencing.
"""


class ResearchAgent:
    """Autonomous research agent using raw Python + OpenRouter."""

    def __init__(self):
        self.config = AgentConfig()
        self.events = EventEmitter(
            agent_name=self.config.agent_name,
            framework="raw-python",
            dashboard_ws_url=self.config.dashboard_ws_url,
        )
        self.wallet = WalletManager(
            self.config.agent_wallet_path, self.config.solana_rpc_url
        )
        self.api_understanding: dict = {}
        self.api_key: str = ""
        self.agent_id: str = ""
        self._state_dir = Path(self.config.state_dir)
        self._state_dir.mkdir(parents=True, exist_ok=True)
        self._http = httpx.AsyncClient(timeout=60)

    # ── Lifecycle ──────────────────────────────────────────────────────

    async def run(self):
        """Main entrypoint: discover → register → operate."""
        await self.events.connect_dashboard()
        await self.events.emit("BOOT", {
            "agent_name": self.config.agent_name,
            "wallet": self.wallet.address,
            "platform_url": self.config.platform_url,
        })

        try:
            await self._discover()
            await self._register()
            async with asyncio.TaskGroup() as tg:
                tg.create_task(self._heartbeat_loop())
                tg.create_task(self._task_loop())
        except Exception as e:
            await self.events.emit("ERROR", {"error": str(e), "phase": "lifecycle"})
            log.exception("Agent crashed")
            raise
        finally:
            await self._http.aclose()
            await self.events.close()

    # ── Discovery ──────────────────────────────────────────────────────

    async def _discover(self):
        """Fetch platform docs and use LLM to understand the API."""
        cache_path = self._state_dir / "api_understanding.json"

        # Use cached understanding if available
        if cache_path.exists():
            self.api_understanding = json.loads(cache_path.read_text())
            await self.events.emit("DISCOVERY", {
                "phase": "cached",
                "detail": "Loaded API understanding from cache",
            })
            log.info("Loaded cached API understanding")
            return

        await self.events.emit("DISCOVERY", {
            "phase": "fetching_docs",
            "detail": f"Fetching docs from {self.config.platform_url}",
        })

        # Fetch platform documentation
        citizen_md = await self._fetch_text(f"{self.config.platform_url}/citizen.md")
        openapi_spec = await self._fetch_text(
            f"{self.config.platform_url}/openapi.json"
        )

        await self.events.emit("DISCOVERY", {
            "phase": "llm_parsing",
            "detail": f"Sending {len(citizen_md)} chars of docs to LLM for comprehension",
        })

        # LLM reads the docs and extracts structured understanding
        prompt = DISCOVERY_PROMPT.format(
            citizen_md=citizen_md, openapi_spec=openapi_spec
        )
        await self.events.emit("THINKING", {
            "prompt_summary": "Parsing platform documentation to extract API structure",
            "model": self.config.llm_model,
        })

        response = await llm.chat_json(
            messages=[{"role": "user", "content": prompt}],
            model=self.config.llm_model,
            api_key=self.config.openrouter_api_key,
        )
        self.api_understanding = json.loads(response)

        # Cache to disk
        cache_path.write_text(json.dumps(self.api_understanding, indent=2))

        await self.events.emit("DISCOVERY", {
            "phase": "complete",
            "detail": f"Extracted understanding of {len(self.api_understanding)} API fields",
            "endpoints_found": list(self.api_understanding.keys()),
        })
        log.info("API discovery complete: %s", list(self.api_understanding.keys()))

    async def _fetch_text(self, url: str) -> str:
        resp = await self._http.get(url)
        resp.raise_for_status()
        content_type = resp.headers.get("content-type", "")
        if "json" in content_type:
            return json.dumps(resp.json(), indent=2)
        return resp.text

    # ── Registration ───────────────────────────────────────────────────

    async def _register(self):
        """Self-register on the platform using LLM-derived API knowledge."""
        key_path = self._state_dir / "api_key.txt"

        # Skip if already registered
        if key_path.exists():
            self.api_key = key_path.read_text().strip()
            self.agent_id = f"{self.config.agent_name}.agicitizens"
            self.events.agent_id = self.agent_id
            await self.events.emit("REGISTRATION", {
                "status": "already_registered",
                "agent_id": self.agent_id,
            })
            log.info("Already registered as %s", self.agent_id)
            return

        await self.events.emit("REGISTRATION", {"status": "starting"})

        # Get payment info and make X402 payment
        api = self.api_understanding
        base_url = api.get("base_url", self.config.platform_url)

        payment_info = await x402.get_payment_info(base_url)
        platform_wallet = payment_info.get("data", payment_info).get(
            "wallet", payment_info.get("platform_wallet", "")
        )
        usdc_mint = payment_info.get("data", payment_info).get(
            "usdc_mint", payment_info.get("usdc_mint_address", "")
        )

        await self.events.emit("ACTION", {
            "action": "x402_payment",
            "amount": 1.0,
            "recipient": platform_wallet,
        })

        payment_proof = await x402.make_x402_payment(
            wallet=self.wallet,
            amount_usdc=1.0,
            recipient_address=platform_wallet,
            usdc_mint_address=usdc_mint,
        )

        # Build registration payload — the agent decides what to send
        # based on its understanding of citizen.md
        registration_data = {
            "name": self.config.agent_name,
            "category": "research",
            "wallet": self.wallet.address,
            "capabilities": ["summarization", "synthesis", "report_generation"],
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Research question"},
                    "depth": {
                        "type": "string",
                        "enum": ["shallow", "deep"],
                        "default": "shallow",
                    },
                    "format": {
                        "type": "string",
                        "enum": ["summary", "report"],
                        "default": "summary",
                    },
                },
                "required": ["query"],
            },
            "output_schema": {
                "type": "object",
                "properties": {
                    "findings": {"type": "string"},
                    "sources": {"type": "array", "items": {"type": "string"}},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                },
                "required": ["findings", "sources", "confidence"],
            },
            "pricing": {"base_price": 0.50, "model": "per-task"},
            "sla": {
                "max_duration_seconds": 300,
                "callback_url": None,
            },
        }

        # Make registration request
        register_path = api.get("register_endpoint", "/agents/register")
        register_url = f"{base_url}{register_path}"
        payment_header = api.get("x402_header_name", "X-Payment")

        await self.events.emit("ACTION", {
            "action": "register",
            "url": register_url,
            "agent_name": self.config.agent_name,
        })

        resp = await self._http.post(
            register_url,
            json=registration_data,
            headers={payment_header: payment_proof},
        )
        resp.raise_for_status()
        result = resp.json()

        # Extract credentials from response
        data = result.get("data", result)
        self.api_key = data.get("api_key", "")
        self.agent_id = data.get("agent_id", f"{self.config.agent_name}.agicitizens")
        self.events.agent_id = self.agent_id

        # Persist api key — it's shown only once
        key_path.write_text(self.api_key)

        await self.events.emit("REGISTRATION", {
            "status": "complete",
            "agent_id": self.agent_id,
            "pda_address": data.get("pda_address", ""),
        })
        log.info("Registered as %s", self.agent_id)

    # ── Auth header ────────────────────────────────────────────────────

    def _auth_headers(self) -> dict:
        prefix = self.api_understanding.get("auth_prefix", "Bearer ")
        header_name = self.api_understanding.get("auth_header", "Authorization")
        return {header_name: f"{prefix}{self.api_key}"}

    # ── Heartbeat ──────────────────────────────────────────────────────

    async def _heartbeat_loop(self):
        api = self.api_understanding
        base_url = api.get("base_url", self.config.platform_url)
        heartbeat_path = api.get("heartbeat_endpoint", "/agents/heartbeat")
        interval = api.get("heartbeat_interval_seconds", 60) - 5  # slightly early

        while True:
            try:
                resp = await self._http.post(
                    f"{base_url}{heartbeat_path}",
                    headers=self._auth_headers(),
                )
                resp.raise_for_status()
                await self.events.emit("HEARTBEAT", {"status": "alive"})
            except Exception as e:
                await self.events.emit("ERROR", {
                    "error": str(e),
                    "phase": "heartbeat",
                })
                log.warning("Heartbeat failed: %s", e)
            await asyncio.sleep(interval)

    # ── Task Loop ──────────────────────────────────────────────────────

    async def _task_loop(self):
        api = self.api_understanding
        base_url = api.get("base_url", self.config.platform_url)
        list_path = api.get("list_tasks_endpoint", "/tasks")
        accept_template = api.get(
            "accept_task_endpoint_template", "/tasks/{task_id}/accept"
        )
        deliver_template = api.get(
            "deliver_task_endpoint_template", "/tasks/{task_id}/deliver"
        )

        while True:
            try:
                # Discover open tasks
                resp = await self._http.get(
                    f"{base_url}{list_path}",
                    params={"status": "OPEN", "category": "research"},
                    headers=self._auth_headers(),
                )
                resp.raise_for_status()
                result = resp.json()
                tasks = result.get("data", result)
                if isinstance(tasks, dict):
                    tasks = tasks.get("tasks", [])

                for task in tasks:
                    task_id = task.get("id", task.get("task_id", ""))
                    if not task_id:
                        continue

                    # Ask LLM whether to accept
                    if not await self._should_accept(task):
                        continue

                    # Accept the task
                    accept_url = f"{base_url}{accept_template.format(task_id=task_id)}"
                    accept_resp = await self._http.post(
                        accept_url, headers=self._auth_headers()
                    )
                    accept_resp.raise_for_status()

                    await self.events.emit("TASK_ACCEPTED", {
                        "task_id": task_id,
                        "budget": task.get("budget_usdc", task.get("budget", 0)),
                    })
                    log.info("Accepted task %s", task_id)

                    # Execute the task
                    output = await self._execute_task(task)

                    # Deliver
                    output_str = json.dumps(output, sort_keys=True)
                    output_hash = hashlib.sha256(output_str.encode()).hexdigest()

                    deliver_url = (
                        f"{base_url}{deliver_template.format(task_id=task_id)}"
                    )
                    deliver_resp = await self._http.post(
                        deliver_url,
                        json={"output": output, "output_hash": output_hash},
                        headers=self._auth_headers(),
                    )
                    deliver_resp.raise_for_status()

                    await self.events.emit("TASK_DELIVERED", {
                        "task_id": task_id,
                        "output_hash": output_hash,
                    })
                    log.info("Delivered task %s", task_id)

            except Exception as e:
                await self.events.emit("ERROR", {
                    "error": str(e),
                    "phase": "task_loop",
                })
                log.warning("Task loop error: %s", e)

            await asyncio.sleep(15)

    async def _should_accept(self, task: dict) -> bool:
        """Use LLM to evaluate whether this task matches our capabilities."""
        prompt = TASK_EVAL_PROMPT.format(task_json=json.dumps(task, indent=2))
        await self.events.emit("THINKING", {
            "prompt_summary": f"Evaluating task {task.get('id', '?')}",
            "model": self.config.llm_model,
        })
        try:
            response = await llm.chat_json(
                messages=[{"role": "user", "content": prompt}],
                model=self.config.llm_model,
                api_key=self.config.openrouter_api_key,
            )
            decision = json.loads(response)
            accept = decision.get("accept", False)
            await self.events.emit("OBSERVATION", {
                "decision": "accept" if accept else "reject",
                "reason": decision.get("reason", ""),
                "task_id": task.get("id", "?"),
            })
            return accept
        except Exception as e:
            log.warning("Task evaluation failed: %s", e)
            return False

    async def _execute_task(self, task: dict) -> dict:
        """Use LLM to produce research output for the task."""
        task_input = task.get("input", task)
        prompt = TASK_EXEC_PROMPT.format(task_input=json.dumps(task_input, indent=2))

        await self.events.emit("THINKING", {
            "prompt_summary": f"Executing research for task {task.get('id', '?')}",
            "model": self.config.llm_model,
        })

        response = await llm.chat_json(
            messages=[{"role": "user", "content": prompt}],
            model=self.config.llm_model,
            api_key=self.config.openrouter_api_key,
        )

        output = json.loads(response)
        await self.events.emit("OBSERVATION", {
            "result": "task_output_generated",
            "task_id": task.get("id", "?"),
            "confidence": output.get("confidence", 0),
        })
        return output


async def main():
    agent = ResearchAgent()
    await agent.run()


if __name__ == "__main__":
    asyncio.run(main())
