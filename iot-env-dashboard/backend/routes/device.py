"""
Device Telemetry & Streaming Route.
AWS Architecture Mapping: Mimics MQTT publish bridge to AWS IoT Core and
real-time subscriber streaming for live operational dashboards.
"""

import asyncio
import json
import time
from fastapi import APIRouter, HTTPException, status, Request
from fastapi.responses import StreamingResponse
from typing import Dict, Any
from backend.models.telemetry import TelemetryPacket, ProcessedReading
from backend.services.iot_core import iot_core
from backend.services.lambda_processor import ValidationError
from backend.services.cloudwatch import cloudwatch
from backend.events import broadcaster

router = APIRouter(prefix="/api", tags=["Device & Streaming"])


@router.post("/device/publish", response_model=ProcessedReading, summary="Publish telemetry packet from device")
async def publish_telemetry(packet: TelemetryPacket):
    """
    Receives an ESP32 DHT11 telemetry packet.
    1. Ingests into AWS IoT Core (topic: iot/esp32/dht11/telemetry, QoS 1).
    2. Triggers AWS IoT Core Topic Rule calling ProcessEnvironmentalData Lambda.
    3. Validates hardware operational constraints, executes psychrometric computations,
       saves to S3, and updates CloudWatch metrics.
    4. Broadcasts processed data to live SSE subscribers.
    """
    try:
        processed_data = iot_core.publish(
            topic="iot/esp32/dht11/telemetry",
            payload=packet.model_dump(),
            qos=1,
        )
    except ValidationError as err:
        raise HTTPException(
            status_code=422,
            detail=str(err),
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Internal processing failure: {str(exc)}",
        )

    # Broadcast to active SSE listeners
    broadcaster.publish_nowait("reading", processed_data)

    return processed_data


@router.get("/stream", summary="Server-Sent Events real-time data stream")
async def sse_stream(request: Request):
    """
    Server-Sent Events (SSE) stream providing real-time telemetry readings,
    CloudWatch alarm transitions, and periodic heartbeats.
    """
    async def event_generator():
        client_queue = broadcaster.subscribe()
        try:
            # Emit initial connection state and current alarms
            initial_state = {
                "status": "connected",
                "timestamp": time.time(),
                "alarms": cloudwatch.alarms,
            }
            yield f"event: init\ndata: {json.dumps(initial_state)}\n\n"

            while True:
                # Check for client disconnect
                if await request.is_disconnected():
                    break

                try:
                    # Wait for next event with a 2-second timeout for heartbeat and offline check
                    message = await asyncio.wait_for(client_queue.get(), timeout=2.0)
                    yield message
                except asyncio.TimeoutError:
                    # Periodic heartbeat: check offline alarm and send ping
                    offline_event = cloudwatch.evaluate_offline_alarm()
                    ping_payload = {
                        "ping": True,
                        "time": time.time(),
                        "alarms": cloudwatch.alarms,
                    }
                    yield f"event: ping\ndata: {json.dumps(ping_payload)}\n\n"

        except asyncio.CancelledError:
            pass
        finally:
            broadcaster.unsubscribe(client_queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
