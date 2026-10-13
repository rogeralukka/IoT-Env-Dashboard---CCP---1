"""
Quick Backend Verification Script.
Simulates ESP32 telemetry transmission and verifies all Virtual AWS endpoints.
Can be executed directly: python tests/quick_test.py
"""

import sys
import time
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)


def log_pass(msg: str):
    print(f"  [\033[92mPASS\033[0m] {msg}")


def log_fail(msg: str):
    print(f"  [\033[91mFAIL\033[0m] {msg}")


def main():
    print("=" * 70)
    print(" IoT Environmental Dashboard - Virtual AWS Backend Verification")
    print("=" * 70)

    # 1. Test Root Service Discovery
    print("\n[1/7] Testing Root Endpoint & Discovery...")
    res = client.get("/")
    assert res.status_code == 200, f"Expected 200, got {res.status_code}"
    log_pass("Root endpoint returned status ONLINE")

    # 2. Test Weather Service
    print("\n[2/7] Testing Weather Service (Open-Meteo & Cache)...")
    cities = ["Hasanparthy", "Hyderabad", "Warangal", "Bengaluru", "Delhi", "Mumbai"]
    for city in cities:
        res = client.get(f"/api/weather?city={city}")
        assert res.status_code == 200, f"Failed weather fetch for {city}"
        w_data = res.json()
        log_pass(f"Weather for {city:10s} -> Temp: {w_data['current']['temperature_2m']} C, "
                 f"RH: {w_data['current']['relative_humidity_2m']}%, Source: {w_data['source']}")

    # 3. Post 5 Telemetry Packets
    print("\n[3/7] Publishing 5 Simulated ESP32 Telemetry Packets...")
    test_packets = [
        {"device_id": "esp32_env_node_01", "timestamp": time.time(), "packet_id": 1,
         "temperature_c": 28.4, "humidity_pct": 65.0, "wifi_rssi_dbm": -58, "sensor_status": "OK"},
        {"device_id": "esp32_env_node_01", "timestamp": time.time() + 1, "packet_id": 2,
         "temperature_c": 38.2, "humidity_pct": 45.0, "wifi_rssi_dbm": -62, "sensor_status": "OK"},
        {"device_id": "esp32_env_node_01", "timestamp": time.time() + 2, "packet_id": 3,
         "temperature_c": 26.5, "humidity_pct": 84.0, "wifi_rssi_dbm": -54, "sensor_status": "OK"},
        {"device_id": "esp32_env_node_01", "timestamp": time.time() + 3, "packet_id": 4,
         "temperature_c": 36.8, "humidity_pct": 82.0, "wifi_rssi_dbm": -70, "sensor_status": "OK"},
        {"device_id": "esp32_env_node_01", "timestamp": time.time() + 4, "packet_id": 5,
         "temperature_c": 24.5, "humidity_pct": 52.0, "wifi_rssi_dbm": -48, "sensor_status": "OK"},
    ]

    for p in test_packets:
        res = client.post("/api/device/publish", json=p)
        assert res.status_code == 200, f"Publish failed for packet {p['packet_id']}"
        processed = res.json()
        log_pass(f"Packet #{processed['packet_id']} Processed: "
                 f"T={processed['temperature_c']}C, HI={processed['heat_index_c']}C, "
                 f"DP={processed['dew_point_c']}C, AH={processed['absolute_humidity_gm3']}g/m3 | "
                 f"S3Key={processed['s3_key']}")

    # 4. Verify AWS IoT Core & Lambda
    print("\n[4/7] Auditing AWS IoT Core & Lambda Invocations...")
    iot_res = client.get("/api/cloud/messages")
    assert iot_res.status_code == 200
    iot_stats = iot_res.json()
    log_pass(f"AWS IoT Core: {iot_stats['total_messages_received']} messages received on {iot_stats['configured_topic']}")

    lambda_res = client.get("/api/cloud/lambda")
    assert lambda_res.status_code == 200
    lambda_stats = lambda_res.json()
    log_pass(f"AWS Lambda ({lambda_stats['function_name']}): {lambda_stats['invocations_count']} invocations, "
             f"Last Duration: {lambda_stats['last_duration_ms']} ms")

    # 5. Verify Amazon S3 Datalake & CloudWatch Alarms
    print("\n[5/7] Auditing Amazon S3 Datalake & CloudWatch Alarms...")
    s3_res = client.get("/api/cloud/s3")
    assert s3_res.status_code == 200
    s3_info = s3_res.json()
    log_pass(f"Amazon S3 ({s3_info['bucket_name']}): {s3_info['total_objects']} objects, "
             f"Total Size: {s3_info['total_size_bytes']} bytes")

    cw_res = client.get("/api/cloud/alarms")
    assert cw_res.status_code == 200
    cw_info = cw_res.json()
    for alarm_name, alarm_data in cw_info["alarms"].items():
        log_pass(f"CloudWatch Alarm [{alarm_name}]: State = {alarm_data['state']} ({alarm_data['threshold']})")

    # 6. Verify DHT11 Range Validation
    print("\n[6/7] Verifying Hardware Operational Limit Validation...")
    bad_packet = {
        "device_id": "esp32_env_node_01", "timestamp": time.time(), "packet_id": 999,
        "temperature_c": 62.0, "humidity_pct": 50.0, "wifi_rssi_dbm": -60, "sensor_status": "OK"
    }
    bad_res = client.post("/api/device/publish", json=bad_packet)
    assert bad_res.status_code == 422, f"Expected 422 for out-of-bounds reading, got {bad_res.status_code}"
    log_pass(f"Correctly rejected out-of-range temperature (62 C): {bad_res.json()['detail']}")

    # 7. Verify S3 Export Endpoints
    print("\n[7/7] Verifying Datalake Export Endpoints...")
    json_export = client.get("/api/export?format=json")
    assert json_export.status_code == 200
    log_pass(f"JSON Export: Retrieved {json_export.json()['record_count']} records")

    csv_export = client.get("/api/export?format=csv")
    assert csv_export.status_code == 200
    csv_lines = csv_export.text.strip().split("\n")
    log_pass(f"CSV Export: Retrieved {len(csv_lines)} lines (header + data)")

    print("\n" + "=" * 70)
    print(" ALL BACKEND & VIRTUAL AWS TESTS PASSED SUCCESSFULLY! ")
    print("=" * 70)


if __name__ == "__main__":
    main()
