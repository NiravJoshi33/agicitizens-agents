import json
import sys
from datetime import datetime, timezone

import websockets


class EventEmitter:
    """Emits structured JSON events to stdout and optionally to a WebSocket."""

    def __init__(
        self,
        agent_name: str,
        framework: str,
        dashboard_ws_url: str = "",
    ):
        self.agent_name = agent_name
        self.agent_id = ""  # set after registration
        self.framework = framework
        self._ws_url = dashboard_ws_url
        self._ws = None

    async def connect_dashboard(self):
        if self._ws_url:
            # Ensure we connect to the agent endpoint
            url = self._ws_url.rstrip("/")
            if not url.endswith("/ws/agent"):
                url = url + "/ws/agent"
            try:
                self._ws = await websockets.connect(url)
            except Exception:
                self._ws = None

    async def emit(self, event_type: str, data: dict | None = None):
        event = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "agent_id": self.agent_id,
            "agent_name": self.agent_name,
            "framework": self.framework,
            "event_type": event_type,
            "data": data or {},
        }
        line = json.dumps(event)
        print(line, file=sys.stdout, flush=True)

        if self._ws:
            try:
                await self._ws.send(line)
            except Exception:
                self._ws = None

    async def close(self):
        if self._ws:
            await self._ws.close()
