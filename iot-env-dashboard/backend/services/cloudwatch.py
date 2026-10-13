"""
CloudWatch Service (Amazon CloudWatch Simulator).
AWS Architecture Mapping: Mimics Amazon CloudWatch Metrics, Alarms, and Alarm History.
Maintains in-memory metric buffers (last 200 points), evaluates alarm thresholds,
tracks state changes, and dispatches notifications on alarm transitions.
"""

import time
from collections import deque
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Callable


class CloudWatchService:
    """
    Virtual Amazon CloudWatch monitoring engine.
    Maintains metric time-series and evaluates rule-based operational alarms.
    """

    def __init__(self, max_metrics: int = 200, offline_threshold_seconds: float = 10.0):
        self.metrics: deque[Dict[str, Any]] = deque(maxlen=max_metrics)
        self.offline_threshold_seconds = offline_threshold_seconds
        self.last_packet_timestamp: Optional[float] = None
        self.listeners: List[Callable[[Dict[str, Any]], None]] = []

        now_iso = datetime.now(timezone.utc).isoformat()
        # Initial alarm states
        self.alarms: Dict[str, Dict[str, Any]] = {
            "HighTemperatureAlarm": {
                "alarm_name": "HighTemperatureAlarm",
                "state": "OK",
                "threshold": "> 35.0 C",
                "last_updated": now_iso,
                "reason": "Initial state: temperature within safe range",
            },
            "HighHumidityAlarm": {
                "alarm_name": "HighHumidityAlarm",
                "state": "OK",
                "threshold": "> 80.0 %RH",
                "last_updated": now_iso,
                "reason": "Initial state: relative humidity within safe range",
            },
            "SensorOfflineAlarm": {
                "alarm_name": "SensorOfflineAlarm",
                "state": "OK",
                "threshold": "No packet received for > 10.0 seconds",
                "last_updated": now_iso,
                "reason": "Initial state: waiting for device heartbeat",
            },
        }

        # Alarm transition history audit log (most recent first)
        self.alarm_history: List[Dict[str, Any]] = []

    def subscribe_alarm_listener(self, callback: Callable[[Dict[str, Any]], None]) -> None:
        """Registers a callback to receive alarm state change events."""
        self.listeners.append(callback)

    def _trigger_state_change(self, alarm_name: str, previous_state: str, new_state: str, reason: str) -> None:
        """Records an alarm state transition in history and notifies listeners."""
        now_iso = datetime.now(timezone.utc).isoformat()
        self.alarms[alarm_name]["state"] = new_state
        self.alarms[alarm_name]["last_updated"] = now_iso
        self.alarms[alarm_name]["reason"] = reason

        event = {
            "alarm_name": alarm_name,
            "previous_state": previous_state,
            "new_state": new_state,
            "timestamp": now_iso,
            "reason": reason,
        }
        self.alarm_history.insert(0, event)
        if len(self.alarm_history) > 100:
            self.alarm_history.pop()

        for callback in self.listeners:
            try:
                callback(event)
            except Exception:
                pass

    def put_metric_data(self, reading: Dict[str, Any]) -> None:
        """
        Ingests a processed reading into the metric time-series and evaluates alarms.
        """
        now = time.time()
        self.last_packet_timestamp = now

        metric_point = {
            "timestamp": reading.get("timestamp", now),
            "received_at": datetime.now(timezone.utc).isoformat(),
            "temperature_c": reading.get("temperature_c"),
            "humidity_pct": reading.get("humidity_pct"),
            "heat_index_c": reading.get("heat_index_c"),
            "dew_point_c": reading.get("dew_point_c"),
            "absolute_humidity_gm3": reading.get("absolute_humidity_gm3"),
            "wifi_rssi_dbm": reading.get("wifi_rssi_dbm"),
            "device_id": reading.get("device_id"),
            "packet_id": reading.get("packet_id"),
        }
        self.metrics.append(metric_point)

        # 1. Evaluate HighTemperatureAlarm (>35 C)
        temp = reading.get("temperature_c", 0.0)
        curr_temp_state = self.alarms["HighTemperatureAlarm"]["state"]
        if temp > 35.0:
            if curr_temp_state != "ALARM":
                self._trigger_state_change(
                    "HighTemperatureAlarm",
                    curr_temp_state,
                    "ALARM",
                    f"Threshold breached: Temperature {temp:.1f} C exceeds 35.0 C",
                )
        else:
            if curr_temp_state != "OK":
                self._trigger_state_change(
                    "HighTemperatureAlarm",
                    curr_temp_state,
                    "OK",
                    f"Threshold normalized: Temperature {temp:.1f} C is <= 35.0 C",
                )

        # 2. Evaluate HighHumidityAlarm (>80 %RH)
        hum = reading.get("humidity_pct", 0.0)
        curr_hum_state = self.alarms["HighHumidityAlarm"]["state"]
        if hum > 80.0:
            if curr_hum_state != "ALARM":
                self._trigger_state_change(
                    "HighHumidityAlarm",
                    curr_hum_state,
                    "ALARM",
                    f"Threshold breached: Humidity {hum:.1f}% exceeds 80.0%",
                )
        else:
            if curr_hum_state != "OK":
                self._trigger_state_change(
                    "HighHumidityAlarm",
                    curr_hum_state,
                    "OK",
                    f"Threshold normalized: Humidity {hum:.1f}% is <= 80.0%",
                )

        self.latest_packet_id = reading.get("packet_id", 0)
        self.latest_device_id = reading.get("device_id", "ESP32-DHT11-NODE-01")

        # 3. If SensorOfflineAlarm was in ALARM, restore to OK because packet arrived
        curr_offline_state = self.alarms["SensorOfflineAlarm"]["state"]
        if curr_offline_state != "OK":
            self._trigger_state_change(
                "SensorOfflineAlarm",
                curr_offline_state,
                "OK",
                f"Heartbeat restored: Device {self.latest_device_id} published packet {self.latest_packet_id}",
            )
        else:
            self.alarms["SensorOfflineAlarm"]["reason"] = (
                f"Heartbeat active: Device {self.latest_device_id} published packet {self.latest_packet_id}"
            )

    def evaluate_offline_alarm(self) -> Optional[Dict[str, Any]]:
        """
        Evaluates the SensorOfflineAlarm based on elapsed time since the last packet.
        Can be called periodically or before serving alarms status.
        """
        curr_state = self.alarms["SensorOfflineAlarm"]["state"]

        if self.last_packet_timestamp is None:
            # Device has never published yet; remain OK or transition if required
            return None

        elapsed = time.time() - self.last_packet_timestamp
        dev_id = getattr(self, "latest_device_id", "ESP32-DHT11-NODE-01")
        pkt_id = getattr(self, "latest_packet_id", 0)
        pkt_str = f"Device {dev_id} published packet {pkt_id}" if pkt_id else f"Last packet received {elapsed:.1f}s ago"

        if elapsed > self.offline_threshold_seconds:
            if curr_state != "ALARM":
                self._trigger_state_change(
                    "SensorOfflineAlarm",
                    curr_state,
                    "ALARM",
                    f"Heartbeat missing: No telemetry received for {elapsed:.1f}s (threshold: {self.offline_threshold_seconds}s)",
                )
                return self.alarms["SensorOfflineAlarm"]
        else:
            if curr_state != "OK":
                self._trigger_state_change(
                    "SensorOfflineAlarm",
                    curr_state,
                    "OK",
                    f"Heartbeat restored: {pkt_str}",
                )
                return self.alarms["SensorOfflineAlarm"]
            else:
                self.alarms["SensorOfflineAlarm"]["reason"] = f"Heartbeat active: {pkt_str}"

        return None

    def reset(self) -> None:
        """Resets metric buffer, alarm states, and heartbeat tracker."""
        self.metrics.clear()
        self.last_packet_timestamp = None
        self.latest_packet_id = 0
        self.latest_device_id = "ESP32-DHT11-NODE-01"
        now_iso = datetime.now(timezone.utc).isoformat()
        self.alarms["HighTemperatureAlarm"]["state"] = "OK"
        self.alarms["HighTemperatureAlarm"]["last_updated"] = now_iso
        self.alarms["HighTemperatureAlarm"]["reason"] = "Initial state: temperature within safe range"
        self.alarms["HighHumidityAlarm"]["state"] = "OK"
        self.alarms["HighHumidityAlarm"]["last_updated"] = now_iso
        self.alarms["HighHumidityAlarm"]["reason"] = "Initial state: relative humidity within safe range"
        self.alarms["SensorOfflineAlarm"]["state"] = "OK"
        self.alarms["SensorOfflineAlarm"]["last_updated"] = now_iso
        self.alarms["SensorOfflineAlarm"]["reason"] = "Initial state: waiting for device heartbeat"
        self.alarm_history.clear()

    def get_status(self) -> Dict[str, Any]:
        """
        Returns full CloudWatch status including metrics, alarms, and history.
        """
        # Ensure offline status is freshly evaluated
        self.evaluate_offline_alarm()

        return {
            "alarms": self.alarms,
            "metric_points_count": len(self.metrics),
            "recent_metrics": list(self.metrics)[-30:],  # Last 30 points for fast UI graphs
            "history": self.alarm_history[:50],
            "last_packet_timestamp": self.last_packet_timestamp,
        }


# Singleton instance for application-wide use
cloudwatch = CloudWatchService()
