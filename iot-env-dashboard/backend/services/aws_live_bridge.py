"""
Live AWS Cloud Bridge.
Connects local telemetry to actual AWS Services (IoT Core, S3, CloudWatch, Lambda).
"""

import os
import json
import time
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
        self.dynamodb = None
        self.dynamodb_table = None
        self.bucket_name = None
        self.region = "us-east-1"
        self.account_id = None
        self.iot_endpoint = None
        self._load_env()

    def _load_env(self):
        env_vars = {}
        # Search both iot-env-dashboard/.env and root .env
        candidates = [
            Path(__file__).resolve().parents[2] / ".env",
            Path(__file__).resolve().parents[3] / ".env",
        ]
        for p in candidates:
            if p.exists():
                with open(p, "r") as f:
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
                self.dynamodb = self.session.resource("dynamodb")
                self.dynamodb_table = self.dynamodb.Table("IoTEnvironmentalReadings")

                if self.iot_endpoint:
                    try:
                        self.iot_data = self.session.client("iot-data", endpoint_url=f"https://{self.iot_endpoint}")
                    except Exception:
                        self.iot_data = None

                self.is_configured = True
                logger.info("AWS Live Bridge successfully connected to region %s", self.region)
            except Exception as e:
                logger.warning("AWS Live Bridge initialization failed: %s", e)

    def reconfigure(self, access_key: str, secret_key: str, session_token: Optional[str] = None, region: str = "us-east-1"):
        """Reconfigures AWS session on the fly without server restart and updates .env files."""
        import boto3
        self.region = region
        self.session = boto3.Session(
            aws_access_key_id=access_key.strip(),
            aws_secret_access_key=secret_key.strip(),
            aws_session_token=session_token.strip() if session_token else None,
            region_name=self.region
        )
        self.s3 = self.session.client("s3")
        self.cw = self.session.client("cloudwatch")
        self.dynamodb = self.session.resource("dynamodb")
        self.dynamodb_table = self.dynamodb.Table("IoTEnvironmentalReadings")

        if self.iot_endpoint:
            try:
                self.iot_data = self.session.client("iot-data", endpoint_url=f"https://{self.iot_endpoint}")
            except Exception:
                self.iot_data = None

        self.is_configured = True
        logger.info("AWS Live Bridge reconfigured successfully on region %s", self.region)

        # Persist to .env files
        env_content = f"""AWS_ACCESS_KEY_ID={access_key.strip()}
AWS_SECRET_ACCESS_KEY={secret_key.strip()}
AWS_SESSION_TOKEN={session_token.strip() if session_token else ''}
AWS_DEFAULT_REGION={self.region}
AWS_S3_BUCKET={self.bucket_name or 'iot-env-datalake-218062175263'}
AWS_IOT_ENDPOINT={self.iot_endpoint or 'a4ickajtlfn5p-ats.iot.us-east-1.amazonaws.com'}
AWS_ACCOUNT_ID={self.account_id or '218062175263'}
"""
        for p in [Path(__file__).resolve().parents[2] / ".env", Path(__file__).resolve().parents[3] / ".env"]:
            try:
                with open(p, "w") as f:
                    f.write(env_content)
            except Exception as e:
                logger.warning("Failed to persist updated .env to %s: %s", p, e)

    def forward_reading(self, record: Dict[str, Any]):
        """Forwards live processed telemetry record directly into AWS DynamoDB and S3."""
        if not self.is_configured:
            return

        from decimal import Decimal
        import datetime

        # 1. Direct write into Amazon DynamoDB table
        if self.dynamodb_table:
            try:
                ts = record.get("timestamp")
                if isinstance(ts, (int, float)):
                    # Formatted ISO or string epoch
                    iso_time = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).isoformat()
                else:
                    iso_time = str(ts or datetime.datetime.now(datetime.timezone.utc).isoformat())

                item = {
                    "device_id": str(record.get("device_id", "ESP32_DHT11_Node")),
                    "timestamp": iso_time,
                    "packet_id": Decimal(str(record.get("packet_id", 0))),
                    "temperature_c": Decimal(str(round(float(record.get("temperature_c", 0.0)), 1))),
                    "humidity_pct": Decimal(str(round(float(record.get("humidity_pct", 0.0)), 1))),
                    "heat_index_c": Decimal(str(round(float(record.get("heat_index_c", 0.0)), 1))),
                    "dew_point_c": Decimal(str(round(float(record.get("dew_point_c", 0.0)), 1))),
                    "wifi_rssi_dbm": Decimal(str(record.get("wifi_rssi_dbm", -64))),
                    "sensor_status": str(record.get("sensor_status", "OK"))
                }
                self.dynamodb_table.put_item(Item=item)
            except Exception as e:
                logger.error("Failed to write live reading to DynamoDB: %s", e)

        # 2. Write to S3 datalake
        if self.s3 and self.bucket_name:
            try:
                packet_id = record.get("packet_id", 0)
                ts_raw = record.get("timestamp", time.time())
                now_dt = datetime.datetime.now(datetime.timezone.utc)
                date_prefix = now_dt.strftime("%Y/%m/%d")
                s3_key = f"readings/{date_prefix}/reading_{int(time.time())}_p{packet_id}.json"
                self.s3.put_object(
                    Bucket=self.bucket_name,
                    Key=s3_key,
                    Body=json.dumps(record, default=str),
                    ContentType="application/json"
                )
            except Exception as e:
                logger.error("Failed to write live reading to S3: %s", e)

        # 3. Best-effort IoT Core publish
        if self.iot_data:
            try:
                self.iot_data.publish(
                    topic="iot/esp32/dht11/telemetry",
                    qos=1,
                    payload=json.dumps(record, default=str)
                )
            except Exception:
                pass

    def publish_to_iot_core(self, topic: str, payload: Dict[str, Any]):
        """Forwards packet to real AWS IoT Core MQTT broker."""
        self.forward_reading(payload)

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
