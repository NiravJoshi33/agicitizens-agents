"""Dashboard server — FastAPI + WebSocket.

Agents push structured JSON events via WebSocket.
Browser clients connect and receive all events in real-time.
"""

import asyncio
import json
import logging
from collections import deque
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

app = FastAPI(title="AGICitizens Agent Dashboard")

# In-memory ring buffer for late joiners
EVENT_BUFFER_SIZE = 500
event_buffer: deque[dict] = deque(maxlen=EVENT_BUFFER_SIZE)

# Connected clients: agents push events, browsers receive them
agent_connections: set[WebSocket] = set()
browser_connections: set[WebSocket] = set()

# Track known agents for the agent list
known_agents: dict[str, dict] = {}

STATIC_DIR = Path(__file__).parent / "static"


@app.get("/")
async def index():
    html = (STATIC_DIR / "index.html").read_text()
    return HTMLResponse(html)


@app.websocket("/ws/agent")
async def agent_ws(websocket: WebSocket):
    """Agents connect here to push events."""
    await websocket.accept()
    agent_connections.add(websocket)
    log.info("Agent connected (%d total)", len(agent_connections))
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue

            event_buffer.append(event)

            # Track agent metadata
            agent_name = event.get("agent_name", "")
            if agent_name:
                known_agents[agent_name] = {
                    "agent_name": agent_name,
                    "agent_id": event.get("agent_id", ""),
                    "framework": event.get("framework", ""),
                    "last_event": event.get("event_type", ""),
                    "last_seen": event.get("timestamp", ""),
                }

            # Broadcast to all browser clients
            disconnected = set()
            for browser in browser_connections:
                try:
                    await browser.send_text(raw)
                except Exception:
                    disconnected.add(browser)
            browser_connections -= disconnected

    except WebSocketDisconnect:
        agent_connections.discard(websocket)
        log.info("Agent disconnected (%d remaining)", len(agent_connections))


@app.websocket("/ws/dashboard")
async def dashboard_ws(websocket: WebSocket):
    """Browser clients connect here to receive events."""
    await websocket.accept()
    browser_connections.add(websocket)
    log.info("Dashboard client connected (%d total)", len(browser_connections))

    # Send agent list
    await websocket.send_text(json.dumps({
        "type": "agent_list",
        "agents": list(known_agents.values()),
    }))

    # Send buffered events so late joiners get context
    for event in event_buffer:
        try:
            await websocket.send_text(json.dumps(event))
        except Exception:
            break

    try:
        # Keep connection alive, handle any client messages (e.g., pings)
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        browser_connections.discard(websocket)
        log.info("Dashboard client disconnected (%d remaining)", len(browser_connections))


@app.get("/api/agents")
async def list_agents():
    """REST endpoint for current agent status."""
    return {"agents": list(known_agents.values())}


@app.get("/api/events")
async def list_events(limit: int = 50):
    """REST endpoint for recent events."""
    events = list(event_buffer)[-limit:]
    return {"events": events}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8080)
