"""
S3 Storage Service (Amazon S3 Simulator).
AWS Architecture Mapping: Mimics Amazon S3 bucket 'iot-environmental-datalake'.
Persists processed environmental readings as timestamped JSON objects, manages bucket
storage, and builds CSV/JSON analytics exports.
"""

import os
import json
import csv
import io
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, List, Optional


class S3StoreService:
    """
    Virtual Amazon S3 storage engine.
    Stores data objects in backend/data/ directory representing bucket 'iot-environmental-datalake'.
    """

    BUCKET_NAME = "iot-environmental-datalake"

    def __init__(self, data_dir: Optional[Path] = None):
        if data_dir is None:
            # Default to backend/data relative to this file
            self.data_dir = Path(__file__).resolve().parent.parent / "data"
        else:
            self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def save_reading(self, reading_data: Dict[str, Any]) -> str:
        """
        Saves a processed telemetry reading as a JSON object in the virtual S3 bucket.
        Returns the object key.
        """
        timestamp = reading_data.get("timestamp", time.time())
        packet_id = reading_data.get("packet_id", 0)
        dt_str = datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y%m%d_%H%M%S")
        filename = f"reading_{dt_str}_p{packet_id}.json"
        s3_key = f"{self.BUCKET_NAME}/{filename}"

        file_path = self.data_dir / filename
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(reading_data, f, indent=2)

        return s3_key

    def list_objects(self) -> List[Dict[str, Any]]:
        """
        Lists all stored objects in the virtual S3 bucket with size and timestamp metadata,
        sorted with the most recent files first.
        """
        objects: List[Dict[str, Any]] = []
        if not self.data_dir.exists():
            return objects

        for entry in self.data_dir.glob("reading_*.json"):
            if entry.is_file():
                stat = entry.stat()
                mod_time = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
                objects.append({
                    "key": f"{self.BUCKET_NAME}/{entry.name}",
                    "filename": entry.name,
                    "size_bytes": stat.st_size,
                    "last_modified": mod_time,
                })

        objects.sort(key=lambda x: x["last_modified"], reverse=True)
        return objects

    def reset(self) -> None:
        """
        Purges all stored JSON telemetry files on server start or session reset.
        """
        if self.data_dir.exists():
            for entry in self.data_dir.glob("reading_*.json"):
                if entry.is_file():
                    try:
                        entry.unlink()
                    except Exception:
                        pass

    def get_bucket_info(self) -> Dict[str, Any]:
        """
        Returns bucket metadata, file counts, total storage utilization,
        and recent file manifests.
        """
        objects = self.list_objects()
        total_size = sum(obj["size_bytes"] for obj in objects)
        return {
            "bucket_name": self.BUCKET_NAME,
            "region": "ap-south-1 (simulated)",
            "total_objects": len(objects),
            "total_size_bytes": total_size,
            "objects": objects[:50],  # Return up to the latest 50 for API overview
            "last_5_files": objects[:5],  # Detailed list of last 5 objects
        }

    def export_all_readings_json(self) -> List[Dict[str, Any]]:
        """
        Retrieves and parses all stored JSON readings in chronological order.
        """
        readings: List[Dict[str, Any]] = []
        files = sorted(self.data_dir.glob("reading_*.json"), key=lambda p: p.stat().st_mtime)

        for filepath in files:
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    readings.append(data)
            except Exception:
                continue

        return readings

    def export_all_readings_csv(self) -> str:
        """
        Generates a standardized CSV string containing all processed telemetry records.
        """
        readings = self.export_all_readings_json()
        output = io.StringIO()
        fieldnames = [
            "timestamp",
            "processed_at",
            "device_id",
            "packet_id",
            "temperature_c",
            "humidity_pct",
            "heat_index_c",
            "dew_point_c",
            "absolute_humidity_gm3",
            "wifi_rssi_dbm",
            "sensor_status",
            "high_temp_alert",
            "high_humidity_alert",
            "s3_key"
        ]

        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()

        for r in readings:
            alerts = r.get("alerts", {})
            writer.writerow({
                "timestamp": r.get("timestamp"),
                "processed_at": r.get("processed_at"),
                "device_id": r.get("device_id"),
                "packet_id": r.get("packet_id"),
                "temperature_c": r.get("temperature_c"),
                "humidity_pct": r.get("humidity_pct"),
                "heat_index_c": r.get("heat_index_c"),
                "dew_point_c": r.get("dew_point_c"),
                "absolute_humidity_gm3": r.get("absolute_humidity_gm3"),
                "wifi_rssi_dbm": r.get("wifi_rssi_dbm"),
                "sensor_status": r.get("sensor_status"),
                "high_temp_alert": alerts.get("high_temp", False),
                "high_humidity_alert": alerts.get("high_humidity", False),
                "s3_key": r.get("s3_key", "")
            })

        return output.getvalue()


# Singleton instance for application-wide use
s3_store = S3StoreService()
