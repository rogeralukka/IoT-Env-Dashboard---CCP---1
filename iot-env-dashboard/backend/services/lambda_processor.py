"""
Lambda Processing Service (AWS Lambda Simulator).
AWS Architecture Mapping: Mimics AWS Lambda function 'ProcessEnvironmentalData'
invoked by AWS IoT Core Topic Rules.
Performs data validation (DHT11 physical limits), psychrometric calculations (Dew Point,
Absolute Humidity, Heat Index), alert generation, data-lake archiving (S3), and metric ingestion (CloudWatch).
"""

import math
import time
import uuid
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
from backend.services.s3_store import s3_store
from backend.services.cloudwatch import cloudwatch


class ValidationError(Exception):
    """Raised when incoming sensor payload falls outside valid hardware operational constraints."""
    pass


class LambdaProcessorService:
    """
    Virtual AWS Lambda runtime for ProcessEnvironmentalData.
    """

    FUNCTION_NAME = "ProcessEnvironmentalData"
    RUNTIME = "python3.12"
    MEMORY_MB = 128

    def __init__(self):
        self.invocations_count: int = 0
        self.last_duration_ms: float = 0.0
        self.invocation_logs: List[Dict[str, Any]] = []
        self.log_lines: List[str] = []

    def reset(self) -> None:
        """Resets invocation counts, logs, and execution history."""
        self.invocations_count = 0
        self.last_duration_ms = 0.0
        self.invocation_logs.clear()
        self.log_lines.clear()

    # =========================================================================
    # Psychrometric Formulas
    # =========================================================================

    @staticmethod
    def calculate_dew_point(temp_c: float, humidity_pct: float) -> float:
        """
        Dew Point calculation using the Magnus-Tetens formula.
        a = 17.62, b = 243.12
        gamma = ln(RH / 100) + (a * T) / (b + T)
        Td = (b * gamma) / (a - gamma)
        """
        rh_clamped = max(min(humidity_pct, 100.0), 0.1)
        a = 17.62
        b = 243.12
        gamma = math.log(rh_clamped / 100.0) + (a * temp_c) / (b + temp_c)
        dew_point = (b * gamma) / (a - gamma)
        return round(dew_point, 2)

    @staticmethod
    def calculate_absolute_humidity(temp_c: float, humidity_pct: float) -> float:
        """
        Absolute humidity in g/m3.
        AH = 6.112 * exp(17.67 * T / (T + 243.5)) * RH * 2.1674 / (273.15 + T)
        """
        rh_clamped = max(min(humidity_pct, 100.0), 0.0)
        numerator = 6.112 * math.exp((17.67 * temp_c) / (temp_c + 243.5)) * rh_clamped * 2.1674
        denominator = 273.15 + temp_c
        ah = numerator / denominator
        return round(ah, 2)

    @staticmethod
    def calculate_heat_index(temp_c: float, humidity_pct: float) -> float:
        """
        Calculates Heat Index in Celsius using the National Weather Service (NWS)
        Rothfusz regression algorithm with low and high humidity adjustments.
        """
        # Convert C to F
        f = temp_c * 1.8 + 32.0
        rh = humidity_pct

        # Simple formula
        hi_simple = 0.5 * (f + 61.0 + (f - 68.0) * 1.2 + rh * 0.094)
        hi_avg = 0.5 * (hi_simple + f)

        if hi_avg < 80.0:
            hi_f = hi_avg
        else:
            # Full Rothfusz regression
            c1 = -42.379
            c2 = 2.04901523
            c3 = 10.14333127
            c4 = -0.22475541
            c5 = -6.83783e-3
            c6 = -5.481717e-2
            c7 = 1.22874e-3
            c8 = 8.5282e-4
            c9 = -1.99e-6

            hi_f = (
                c1
                + c2 * f
                + c3 * rh
                + c4 * f * rh
                + c5 * (f ** 2)
                + c6 * (rh ** 2)
                + c7 * (f ** 2) * rh
                + c8 * f * (rh ** 2)
                + c9 * (f ** 2) * (rh ** 2)
            )

            # Adjustment 1: Low humidity (RH < 13% and 80 <= F <= 112)
            if rh < 13.0 and 80.0 <= f <= 112.0:
                adj = -((13.0 - rh) / 4.0) * math.sqrt((17.0 - abs(f - 95.0)) / 17.0)
                hi_f += adj

            # Adjustment 2: High humidity (RH > 85% and 80 <= F <= 87)
            elif rh > 85.0 and 80.0 <= f <= 87.0:
                adj = ((rh - 85.0) / 10.0) * ((87.0 - f) / 5.0)
                hi_f += adj

        # Convert back to Celsius
        hi_c = (hi_f - 32.0) * (5.0 / 9.0)
        return round(hi_c, 2)

    # =========================================================================
    # Lambda Handler Execution
    # =========================================================================

    def process_environmental_data(self, packet: Dict[str, Any]) -> Dict[str, Any]:
        """
        AWS Lambda handler function: ProcessEnvironmentalData.
        1. Validates physical sensor ranges (DHT11: 0-50 C, 20-90 %RH).
        2. Calculates Heat Index, Dew Point, and Absolute Humidity.
        3. Identifies threshold alerts.
        4. Writes record to S3 bucket.
        5. Emits metrics to CloudWatch.
        6. Logs execution audit record.
        """
        start_time = time.perf_counter()
        req_id = str(uuid.uuid4())
        now_iso = datetime.now(timezone.utc).isoformat()
        self.invocations_count += 1

        device_id = packet.get("device_id", "unknown_device")
        packet_id = packet.get("packet_id", 0)
        temp_c = packet.get("temperature_c")
        humidity_pct = packet.get("humidity_pct")
        wifi_rssi_dbm = packet.get("wifi_rssi_dbm", -60)
        sensor_status = packet.get("sensor_status", "OK")
        timestamp = packet.get("timestamp", time.time())

        # Step 1: Validation of DHT11 physical constraints
        # Operational range: Temperature 0 to 50 C, Relative Humidity 20 to 90 %
        if temp_c is None or humidity_pct is None:
            duration_ms = round((time.perf_counter() - start_time) * 1000, 2)
            self._log_invocation(req_id, now_iso, duration_ms, "FAILED_VALIDATION", "Missing required sensor readings")
            raise ValidationError("Payload missing temperature_c or humidity_pct")

        if not (0.0 <= temp_c <= 50.0 and 20.0 <= humidity_pct <= 90.0):
            duration_ms = round((time.perf_counter() - start_time) * 1000, 2)
            err_msg = (
                f"DHT11 physical boundary breach: Temperature {temp_c} C (limit: 0-50 C) or "
                f"Humidity {humidity_pct}% (limit: 20-90 %RH) out of specification."
            )
            self._log_invocation(req_id, now_iso, duration_ms, "FAILED_VALIDATION", err_msg)
            raise ValidationError(err_msg)

        # Step 2: Formulas & Psychrometric Calculations
        dew_point_c = self.calculate_dew_point(temp_c, humidity_pct)
        absolute_humidity_gm3 = self.calculate_absolute_humidity(temp_c, humidity_pct)
        heat_index_c = self.calculate_heat_index(temp_c, humidity_pct)

        # Step 3: Immediate alerts
        alerts = {
            "high_temp": temp_c > 35.0,
            "high_humidity": humidity_pct > 80.0,
        }

        # Structure processed reading
        processed_record: Dict[str, Any] = {
            "device_id": device_id,
            "timestamp": timestamp,
            "packet_id": packet_id,
            "temperature_c": temp_c,
            "humidity_pct": humidity_pct,
            "wifi_rssi_dbm": wifi_rssi_dbm,
            "sensor_status": sensor_status,
            "heat_index_c": heat_index_c,
            "dew_point_c": dew_point_c,
            "absolute_humidity_gm3": absolute_humidity_gm3,
            "alerts": alerts,
            "processed_at": now_iso,
        }

        # Step 4: Amazon S3 Persistence
        s3_key = s3_store.save_reading(processed_record)
        processed_record["s3_key"] = s3_key

        # Step 5: CloudWatch Metrics & Alarms
        cloudwatch.put_metric_data(processed_record)

        # Step 6: Log Lambda Execution
        duration_ms = round((time.perf_counter() - start_time) * 1000, 2)
        self.last_duration_ms = duration_ms
        details = (
            f"Successfully processed packet {packet_id} from {device_id} | "
            f"T={temp_c}C, RH={humidity_pct}%, HI={heat_index_c}C | S3Key={s3_key}"
        )
        self._log_invocation(req_id, now_iso, duration_ms, "SUCCESS", details)

        # Granular log lines reflecting the 4 pipeline stages
        ts_short = datetime.now(timezone.utc).strftime("%H:%M:%S")
        self.log_lines.append(f"[{ts_short} UTC] [RECEIVED]   Packet #{packet_id} from {device_id} on topic iot/esp32/dht11/telemetry")
        self.log_lines.append(f"[{ts_short} UTC] [VALIDATED]  DHT11 limits verified: T={temp_c:.1f}C (0-50C), RH={humidity_pct:.0f}% (20-90%RH)")
        self.log_lines.append(f"[{ts_short} UTC] [COMPUTED]   HeatIndex={heat_index_c:.1f}C, DewPoint={dew_point_c:.1f}C, AbsHum={absolute_humidity_gm3:.1f}g/m3")
        self.log_lines.append(f"[{ts_short} UTC] [STORED]     Persisted to S3 key {s3_key} and emitted CloudWatch metrics")
        self.log_lines.append(f"[{ts_short} UTC] [COMPLETED]  Request {req_id[:8]} executed in {duration_ms}ms (Status: 200 OK)")
        if len(self.log_lines) > 50:
            self.log_lines = self.log_lines[-50:]

        return processed_record

    def _log_invocation(self, req_id: str, ts: str, duration_ms: float, status: str, details: str) -> None:
        """Appends an execution record to the Lambda CloudWatch Logs stream."""
        entry = {
            "request_id": req_id,
            "timestamp": ts,
            "duration_ms": duration_ms,
            "status": status,
            "details": details,
        }
        self.invocation_logs.insert(0, entry)
        if len(self.invocation_logs) > 100:
            self.invocation_logs.pop()

    def get_stats(self) -> Dict[str, Any]:
        """Returns Lambda runtime performance and execution statistics."""
        return {
            "function_name": self.FUNCTION_NAME,
            "runtime": self.RUNTIME,
            "memory_mb": self.MEMORY_MB,
            "invocations_count": self.invocations_count,
            "last_duration_ms": self.last_duration_ms,
            "recent_logs": self.invocation_logs[:30],
            "last_5_lines": self.log_lines[-5:] if self.log_lines else [
                "System initialized: waiting for telemetry invocation.",
                "[WAITING] IoT Core Rule: SELECT * FROM 'iot/esp32/dht11/telemetry'",
                "[STANDBY] Lambda execution container warm and ready.",
                "[STANDBY] Datalake connection verified: s3://iot-environmental-datalake",
                "[STANDBY] CloudWatch metrics pipeline linked."
            ],
        }


# Singleton instance for application-wide use
lambda_processor = LambdaProcessorService()
