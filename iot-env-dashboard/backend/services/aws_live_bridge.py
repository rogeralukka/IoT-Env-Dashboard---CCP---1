"""
Live AWS Cloud Bridge.
Connects local telemetry to actual AWS Services (IoT Core, S3, CloudWatch, Lambda).
"""

import os
import json
import logging
from pathlib import Path
from typing import Dict, Any, Optional

logger = logging.getLogger("aws_live_bridge")

class AWSLiveBridge:
    def __init__(self):
        self.is_configured = False
        self.session = None
        self.iot_data = None
        self.s3 = None
        self.cw = None
        self.bucket_name = None
        self.region = "us-east-1"
        self.account_id = None
        self.iot_endpoint = None
        self._load_env()

    def _load_env(self):
        env_path = Path(__file__).resolve().parents[2] / ".env"
        if not env_path.exists():
            return

        env_vars = {}
        with open(env_path, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env_vars[k.strip()] = v.strip()

        if "AWS_ACCESS_KEY_ID" in env_vars and "AWS_SECRET_ACCESS_KEY" in env_vars:
            try:
                import boto3
                self.region = env_vars.get("AWS_DEFAULT_REGION", "us-east-1")
                self.bucket_name = env_vars.get("AWS_S3_BUCKET", "iot-env-datalake-218062175263")
                self.iot_endpoint = env_vars.get("AWS_IOT_ENDPOINT")
                
                self.session = boto3.Session(
                    aws_access_key_id=env_vars["AWS_ACCESS_KEY_ID"],
                    aws_secret_access_key=env_vars["AWS_SECRET_ACCESS_KEY"],
                    aws_session_token=env_vars.get("AWS_SESSION_TOKEN"),
                    region_name=self.region
                )
                self.s3 = self.session.client("s3")
                self.cw = self.session.client("cloudwatch")
                if self.iot_endpoint:
                    self.iot_data = self.session.client("iot-data", endpoint_url=f"https://{self.iot_endpoint}")
                self.is_configured = True
                logger.info("AWS Live Bridge successfully connected to region %s", self.region)
            except Exception as e:
                logger.warning("AWS Live Bridge initialization failed: %s", e)

    def publish_to_iot_core(self, topic: str, payload: Dict[str, Any]):
        """Forwards packet to real AWS IoT Core MQTT broker."""
        if not self.is_configured or not self.iot_data:
            return
        try:
            self.iot_data.publish(
                topic=topic,
                qos=1,
                payload=json.dumps(payload)
            )
        except Exception as e:
            logger.error("Failed to forward packet to real AWS IoT Core: %s", e)

    def get_live_aws_status(self) -> Dict[str, Any]:
        """Queries actual AWS account for live S3 objects and CloudWatch alarms."""
        if not self.is_configured:
            return {
                "connected": False,
                "message": "AWS credentials not configured"
            }
        
        # 1. Fetch S3 files
        s3_files = []
        try:
            res = self.s3.list_objects_v2(Bucket=self.bucket_name, MaxKeys=10)
            for item in res.get("Contents", []):
                s3_files.append({
                    "key": item["Key"],
                    "size_bytes": item["Size"],
                    "last_modified": item["LastModified"].isoformat()
                })
        except Exception as e:
            logger.error("Error querying real S3: %s", e)

        # 2. Fetch CloudWatch alarms
        alarms_data = []
        try:
            cw_res = self.cw.describe_alarms(AlarmNames=["HighTemperatureAlarm", "HighHumidityAlarm"])
            for a in cw_res.get("MetricAlarms", []):
                alarms_data.append({
                    "name": a["AlarmName"],
                    "state": a["StateValue"],
                    "threshold": a["Threshold"]
                })
        except Exception as e:
            logger.error("Error querying real CloudWatch: %s", e)

        return {
            "connected": True,
            "region": self.region,
            "s3_bucket": self.bucket_name,
            "iot_endpoint": self.iot_endpoint,
            "s3_object_count": len(s3_files),
            "recent_s3_files": s3_files,
            "cloudwatch_alarms": alarms_data
        }

aws_live_bridge = AWSLiveBridge()
