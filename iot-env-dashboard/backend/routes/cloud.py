"""
Cloud Services Audit Route.
AWS Architecture Mapping: Mimics AWS Management Console / AWS CLI read operations
for AWS IoT Core, AWS Lambda, Amazon S3, and Amazon CloudWatch.
Also provides live query bridge to actual AWS Academy cloud resources when configured.
"""

from fastapi import APIRouter
from typing import Dict, Any
from backend.services.iot_core import iot_core
from backend.services.s3_store import s3_store
from backend.services.lambda_processor import lambda_processor
from backend.services.cloudwatch import cloudwatch
from backend.services.aws_live_bridge import aws_live_bridge

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


@router.get("/live-aws", summary="Inspect Real AWS Account Status (S3, CloudWatch, IoT Core)")
def get_real_aws_status() -> Dict[str, Any]:
    """
    Queries your connected real AWS Academy account for live S3 data lake files,
    CloudWatch alarms, and IoT Core endpoint status.
    """
    return aws_live_bridge.get_live_aws_status()


@router.post("/credentials", summary="Update AWS Academy temporary credentials on the fly")
def update_credentials(payload: Dict[str, str]) -> Dict[str, Any]:
    """
    Parses and applies AWS credentials pasted directly from AWS Academy console.
    Accepts raw block (aws_access_key_id=... etc) or JSON fields.
    """
    raw_text = payload.get("raw", "")
    access_key = payload.get("aws_access_key_id")
    secret_key = payload.get("aws_secret_access_key")
    session_token = payload.get("aws_session_token")

    if raw_text:
        for line in raw_text.splitlines():
            line = line.strip()
            if "=" in line:
                k, v = line.split("=", 1)
                k = k.strip().lower()
                v = v.strip()
                if "access_key_id" in k:
                    access_key = v
                elif "secret_access_key" in k:
                    secret_key = v
                elif "session_token" in k:
                    session_token = v

    if not access_key or not secret_key:
        return {"status": "ERROR", "message": "Missing aws_access_key_id or aws_secret_access_key"}

    try:
        aws_live_bridge.reconfigure(
            access_key=access_key,
            secret_key=secret_key,
            session_token=session_token,
            region="us-east-1"
        )
        return {"status": "SUCCESS", "message": "AWS Academy credentials updated and connected successfully!"}
    except Exception as e:
        return {"status": "ERROR", "message": str(e)}


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
