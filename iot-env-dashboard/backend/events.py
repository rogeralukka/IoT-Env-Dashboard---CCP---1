"""
Event Broadcaster for Server-Sent Events (SSE).
Enables real-time push of processed telemetry readings and CloudWatch alarm state changes
to connected frontend web clients.
"""

import asyncio
import json
from typing import Set, Dict, Any, Optional


class EventBroadcaster:
    """
    Asynchronous event bus managing active SSE subscriber queues.
    """

    def __init__(self):
        self.subscribers: Set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        """Registers a new SSE client queue."""
        q = asyncio.Queue(maxsize=100)
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        """Removes a disconnected SSE client queue."""
        self.subscribers.discard(q)

    def publish_nowait(self, event_type: str, data: Dict[str, Any]) -> None:
        """
        Dispatches an event non-blockingly to all active subscriber queues.
        Formats messages adhering to the W3C SSE standard:
        event: <type>
        data: <json>
        """
        message = f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
        dead_queues = []
        for q in list(self.subscribers):
            try:
                q.put_nowait(message)
            except asyncio.QueueFull:
                # Discard queue if client is not consuming
                dead_queues.append(q)
            except Exception:
                dead_queues.append(q)

        for q in dead_queues:
            self.subscribers.discard(q)


broadcaster = EventBroadcaster()
