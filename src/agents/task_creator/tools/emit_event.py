#!/usr/bin/env python3
"""Emit a structured JSON event to stdout for the dashboard.

Usage: python emit_event.py <event_type> '<json_data>'

Example: python emit_event.py THINKING '{"prompt_summary": "deciding next task"}'
"""

import json
import os
import sys
from datetime import datetime, timezone


def main():
    if len(sys.argv) < 2:
        print("Usage: python emit_event.py <event_type> [json_data]", file=sys.stderr)
        sys.exit(1)

    event_type = sys.argv[1]
    data = {}
    if len(sys.argv) >= 3:
        try:
            data = json.loads(sys.argv[2])
        except json.JSONDecodeError:
            data = {"message": sys.argv[2]}

    event = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "agent_id": os.environ.get("AGENT_ID", ""),
        "agent_name": os.environ.get("AGENT_NAME", "task-creator-001"),
        "framework": "nanoclaw",
        "event_type": event_type,
        "data": data,
    }

    print(json.dumps(event), flush=True)


if __name__ == "__main__":
    main()
