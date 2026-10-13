"""
IoT Core Service (AWS IoT Core Simulator).
AWS Architecture Mapping: Mimics AWS IoT Core MQTT message broker and Topic Rules engine.
Receives device packets on MQTT topics, buffers the last 50 messages, maintains a global
message counter, and evaluates Topic Rules to dispatch actions to AWS Lambda.
"""

from collections import deque
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
from backend.services.lambda_processor import lambda_processor


class IoTCoreService:
    """
    Virtual AWS IoT Core Message Broker & Rules Engine.
    """

    DEFAULT_TOPIC = "iot/esp32/dht11/telemetry"
    DEFAULT_QOS = 1

    def __init__(self, max_buffer_size: int = 50):
        self.message_counter: int = 0
        self.messages: deque[Dict[str, Any]] = deque(maxlen=max_buffer_size)

    def publish(
        self,
        topic: str = DEFAULT_TOPIC,
        payload: Dict[str, Any] = None,
        qos: int = DEFAULT_QOS
    ) -> Dict[str, Any]:
        """
        Receives an MQTT telemetry packet published from the simulated ESP32 device.
        1. Records the message in the MQTT audit log.
        2. Evaluates the IoT Core Topic Rule:
           Rule: SELECT * FROM 'iot/esp32/dht11/telemetry' -> ACTION: Invoke Lambda ProcessEnvironmentalData.
        3. Returns the downstream processed record.
        """
        if payload is None:
            payload = {}

        self.message_counter += 1
        now_iso = datetime.now(timezone.utc).isoformat()

        # Audit entry for MQTT broker
        record = {
            "message_id": self.message_counter,
            "topic": topic,
            "qos": qos,
            "received_at": now_iso,
            "payload": payload,
        }
        self.messages.append(record)

        # Topic Rule Evaluation
        # When message arrives on iot/esp32/dht11/telemetry, route to ProcessEnvironmentalData Lambda
        if topic == self.DEFAULT_TOPIC or topic.startswith("iot/"):
            processed_reading = lambda_processor.process_environmental_data(payload)
            return processed_reading

        return {
            "status": "ACCEPTED",
            "message": f"Message accepted on {topic} without configured rules action",
            "topic": topic,
            "received_at": now_iso,
        }

    def reset(self) -> None:
        """Resets the message counter and clears buffered messages."""
        self.message_counter = 0
        self.messages.clear()

    def get_stats(self) -> Dict[str, Any]:
        """Returns message broker statistics and recent audit history."""
        msg_list = list(self.messages)
        return {
            "service": "AWS IoT Core (Simulated)",
            "endpoint": "a3virtual-iot-ats.iot.ap-south-1.amazonaws.com (simulated)",
            "protocol": "MQTT over WebSocket / TLS",
            "total_messages_received": self.message_counter,
            "retained_messages_count": len(self.messages),
            "recent_messages": msg_list,  # All retained messages
            "last_10_messages": msg_list[-10:],  # Most recent 10 messages for detail panel
            "configured_topic": self.DEFAULT_TOPIC,
            "default_qos": self.DEFAULT_QOS,
            "rules": [
                {
                    "rule_name": "RouteEnvironmentalTelemetry",
                    "sql": f"SELECT * FROM '{self.DEFAULT_TOPIC}'",
                    "action": "lambda:ProcessEnvironmentalData",
                    "status": "ENABLED",
                }
            ],
        }


# Singleton instance for application-wide use
iot_core = IoTCoreService()
