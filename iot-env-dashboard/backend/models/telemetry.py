"""
Telemetry and Cloud Data Models for IoT Environmental Dashboard.
Provides strict Pydantic type definitions for simulated ESP32 hardware packets,
processed telemetry readings, and virtual AWS cloud service states.
"""

from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field


class TelemetryPacket(BaseModel):
    """
    Simulated ESP32 + DHT11 hardware packet transmitted via MQTT QoS 1.
    Mimics raw sensor reading payload before cloud processing.
    """
    device_id: str = Field(..., description="Unique simulated hardware device identifier, e.g. esp32_env_node_01")
    timestamp: float = Field(..., description="Epoch timestamp of sensor reading (seconds)")
    packet_id: int = Field(..., description="Incrementing transmission packet sequence counter")
    temperature_c: float = Field(..., description="DHT11 ambient temperature in Celsius (operating range 0-50 C)")
    humidity_pct: float = Field(..., description="DHT11 relative humidity percentage (operating range 20-90 %RH)")
    wifi_rssi_dbm: int = Field(..., description="Wi-Fi received signal strength indicator in dBm (-90 to -30 dBm)")
    sensor_status: str = Field(default="OK", description="Sensor self-check health status, e.g. OK, ERROR")


class TelemetryAlerts(BaseModel):
    """
    Immediate thresholds evaluated during Lambda processing:
    - high_temp: True if temperature > 35 C
    - high_humidity: True if relative humidity > 80 %RH
    """
    high_temp: bool = Field(..., description="Indicates temperature exceeds 35 C")
    high_humidity: bool = Field(..., description="Indicates relative humidity exceeds 80%")


class ProcessedReading(BaseModel):
    """
    Fully processed telemetry record produced by AWS Lambda (ProcessEnvironmentalData).
    Enriched with psychrometric calculations, validation flags, and storage metadata.
    """
    device_id: str
    timestamp: float
    packet_id: int
    temperature_c: float
    humidity_pct: float
    wifi_rssi_dbm: int
    sensor_status: str
    heat_index_c: float = Field(..., description="Calculated Heat Index using Rothfusz regression in Celsius")
    dew_point_c: float = Field(..., description="Calculated Dew Point using Magnus-Tetens approximation in Celsius")
    absolute_humidity_gm3: float = Field(..., description="Calculated Absolute Humidity in grams per cubic meter (g/m3)")
    alerts: Dict[str, bool] = Field(..., description="Threshold alerts dictionary: high_temp and high_humidity")
    processed_at: str = Field(..., description="ISO 8601 UTC timestamp of Lambda execution")
    s3_key: Optional[str] = Field(default=None, description="Amazon S3 datalake object key path")


class CloudMessageRecord(BaseModel):
    """
    AWS IoT Core message broker audit entry.
    Captures MQTT topic, QoS level, reception timestamp, and payload.
    """
    topic: str
    qos: int
    received_at: str
    payload: Dict[str, Any]


class LambdaInvocationRecord(BaseModel):
    """
    AWS Lambda execution log entry for ProcessEnvironmentalData.
    """
    request_id: str
    timestamp: str
    duration_ms: float
    status: str  # SUCCESS, FAILED_VALIDATION, ERROR
    details: str


class CloudWatchAlarmState(BaseModel):
    """
    Current state of an individual CloudWatch metric alarm.
    """
    alarm_name: str
    state: str  # OK or ALARM
    last_updated: str
    reason: str
    threshold: str


class CloudWatchAlarmHistory(BaseModel):
    """
    State transition record for CloudWatch alarm history auditing.
    """
    alarm_name: str
    previous_state: str
    new_state: str
    timestamp: str
    reason: str
