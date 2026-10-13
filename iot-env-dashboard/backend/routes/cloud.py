"""
Cloud Services Audit Route.
AWS Architecture Mapping: Mimics AWS Management Console / AWS CLI read operations
for AWS IoT Core, AWS Lambda, Amazon S3, and Amazon CloudWatch.
"""

from fastapi import APIRouter
from typing import Dict, Any
from backend.services.iot_core import iot_core
from backend.services.s3_store import s3_store
from backend.services.lambda_processor import lambda_processor
from backend.services.cloudwatch import cloudwatch

router = APIRouter(prefix="/api/cloud", tags=["Cloud Services (Virtual AWS)"])


@router.get("/messages", summary="Audit AWS IoT Core MQTT message broker")
def get_iot_core_messages() -> Dict[str, Any]:
    """
    Returns AWS IoT Core message broker statistics and retained MQTT packets (up to 50).
    """
    return iot_core.get_stats()


@router.get("/s3", summary="Inspect Amazon S3 bucket iot-environmental-datalake")
def get_s3_bucket_status() -> Dict[str, Any]:
    """
    Returns Amazon S3 datalake inventory, total object count, storage byte metrics,
    and individual file manifests.
    """
    return s3_store.get_bucket_info()


@router.get("/lambda", summary="Inspect AWS Lambda ProcessEnvironmentalData execution metrics")
def get_lambda_metrics() -> Dict[str, Any]:
    """
    Returns AWS Lambda invocation counter, latest execution duration, and CloudWatch Logs stream.
    """
    return lambda_processor.get_stats()


@router.get("/alarms", summary="Inspect Amazon CloudWatch alarms and state transition history")
def get_cloudwatch_alarms() -> Dict[str, Any]:
    """
    Returns Amazon CloudWatch alarms (HighTemperatureAlarm, HighHumidityAlarm, SensorOfflineAlarm),
    current operational states, recent metric buffer, and transition history.
    """
    return cloudwatch.get_status()


@router.post("/reset", summary="Reset session telemetry and virtual AWS services")
def reset_session() -> Dict[str, Any]:
    """
    Resets all virtual AWS services: purges datalake JSON files,
    clears MQTT broker messages, resets Lambda counters and execution logs,
    and resets CloudWatch alarm buffers.
    """
    s3_store.reset()
    iot_core.reset()
    lambda_processor.reset()
    cloudwatch.reset()
    return {
        "status": "SUCCESS",
        "message": "All virtual AWS service metrics and datalake records reset for current session."
    }
