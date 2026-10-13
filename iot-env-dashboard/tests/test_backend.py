"""
Comprehensive Pytest Test Suite for IoT Environmental Dashboard Backend.
Tests all endpoints, AWS simulation modules, validation limits, and psychrometric formulas.
"""

import time
import pytest
from fastapi.testclient import TestClient
from backend.main import app
from backend.services.lambda_processor import lambda_processor
from backend.services.s3_store import s3_store
from backend.services.cloudwatch import cloudwatch
from backend.services.iot_core import iot_core

client = TestClient(app)


def test_root_endpoint():
    """Verify root endpoint returns 200 and /api returns system discovery status."""
    response = client.get("/")
    assert response.status_code == 200

    api_res = client.get("/api")
    assert api_res.status_code == 200
    data = api_res.json()
    assert data["project"] == "IoT Environmental Dashboard"
    assert data["status"] == "ONLINE"
    assert "endpoints" in data


def test_weather_endpoint_and_cache():
    """Verify Open-Meteo weather integration, schema, and caching."""
    # Test Hyderabad
    res = client.get("/api/weather?city=Hyderabad")
    assert res.status_code == 200
    data = res.json()
    assert data["city"] == "Hyderabad"
    assert data["source"] in ["live", "mock"]
    assert "current" in data
    assert "temperature_2m" in data["current"]
    assert "relative_humidity_2m" in data["current"]
    assert "hourly" in data
    assert len(data["hourly"]["time"]) == 24

    # Test caching (subsequent request returns same or cached data)
    res2 = client.get("/api/weather?city=Hyderabad")
    assert res2.status_code == 200
    data2 = res2.json()
    assert data2["city"] == "Hyderabad"


def test_weather_all_cities():
    """Verify all supported cities and Hasanparthy campus coordinates resolve correctly."""
    cities = ["Hasanparthy", "Hyderabad", "Warangal", "Bengaluru", "Delhi", "Mumbai"]
    for city in cities:
        res = client.get(f"/api/weather?city={city}")
        assert res.status_code == 200
        data = res.json()
        assert "current" in data
        assert "hourly" in data

    # Test Hasanparthy specific metadata
    h_res = client.get("/api/weather?city=Hasanparthy")
    assert h_res.status_code == 200
    h_data = h_res.json()
    assert h_data["city"] == "Hasanparthy (Hanamkonda)"
    assert h_data["pin_code"] == "506371"
    assert h_data["coordinates"]["latitude"] == 18.0681
    assert h_data["coordinates"]["longitude"] == 79.5236


def test_formulas_accuracy():
    """Verify psychrometric formulas: Dew Point, Absolute Humidity, and Heat Index."""
    temp = 30.0
    rh = 70.0

    # 1. Dew point calculation
    dp = lambda_processor.calculate_dew_point(temp, rh)
    # At 30 C and 70% RH, dew point is approximately 23.9 C to 24.1 C
    assert 23.0 <= dp <= 25.0

    # 2. Absolute humidity calculation
    ah = lambda_processor.calculate_absolute_humidity(temp, rh)
    # At 30 C and 70% RH, absolute humidity is approximately 21.2 g/m3
    assert 20.0 <= ah <= 23.0

    # 3. Heat index calculation
    hi = lambda_processor.calculate_heat_index(temp, rh)
    # At 30 C and 70% RH (86 F, 70% RH), Heat Index is around 35 C to 36 C
    assert 34.0 <= hi <= 37.0


def test_publish_5_packets_and_verify_pipeline():
    """
    Core Phase 1 requirement:
    Post 5 packets and verify complete AWS simulation pipeline:
    ESP32 -> IoT Core -> Lambda -> S3 -> CloudWatch
    """
    packets = [
        # Packet 1: Normal baseline
        {
            "device_id": "esp32_env_node_01",
            "timestamp": time.time(),
            "packet_id": 101,
            "temperature_c": 28.4,
            "humidity_pct": 65.0,
            "wifi_rssi_dbm": -58,
            "sensor_status": "OK",
        },
        # Packet 2: High Temperature (>35 C) -> triggers HighTemperatureAlarm
        {
            "device_id": "esp32_env_node_01",
            "timestamp": time.time() + 1,
            "packet_id": 102,
            "temperature_c": 38.5,
            "humidity_pct": 45.0,
            "wifi_rssi_dbm": -62,
            "sensor_status": "OK",
        },
        # Packet 3: High Humidity (>80 %) -> triggers HighHumidityAlarm
        {
            "device_id": "esp32_env_node_01",
            "timestamp": time.time() + 2,
            "packet_id": 103,
            "temperature_c": 27.0,
            "humidity_pct": 86.0,
            "wifi_rssi_dbm": -55,
            "sensor_status": "OK",
        },
        # Packet 4: Compound elevated reading
        {
            "device_id": "esp32_env_node_01",
            "timestamp": time.time() + 3,
            "packet_id": 104,
            "temperature_c": 36.0,
            "humidity_pct": 82.0,
            "wifi_rssi_dbm": -68,
            "sensor_status": "OK",
        },
        # Packet 5: Return to normal
        {
            "device_id": "esp32_env_node_01",
            "timestamp": time.time() + 4,
            "packet_id": 105,
            "temperature_c": 25.0,
            "humidity_pct": 50.0,
            "wifi_rssi_dbm": -50,
            "sensor_status": "OK",
        },
    ]

    for p in packets:
        res = client.post("/api/device/publish", json=p)
        assert res.status_code == 200
        data = res.json()
        assert data["device_id"] == p["device_id"]
        assert data["packet_id"] == p["packet_id"]
        assert "heat_index_c" in data
        assert "dew_point_c" in data
        assert "absolute_humidity_gm3" in data
        assert "s3_key" in data
        assert data["s3_key"].startswith("iot-environmental-datalake/")

    # 1. Verify AWS IoT Core retained messages and counter
    iot_res = client.get("/api/cloud/messages")
    assert iot_res.status_code == 200
    iot_data = iot_res.json()
    assert iot_data["total_messages_received"] >= 5
    assert len(iot_data["recent_messages"]) >= 5

    # 2. Verify Amazon S3 datalake objects
    s3_res = client.get("/api/cloud/s3")
    assert s3_res.status_code == 200
    s3_data = s3_res.json()
    assert s3_data["bucket_name"] == "iot-environmental-datalake"
    assert s3_data["total_objects"] >= 5
    assert len(s3_data["objects"]) >= 5

    # 3. Verify AWS Lambda execution metrics
    lambda_res = client.get("/api/cloud/lambda")
    assert lambda_res.status_code == 200
    lambda_data = lambda_res.json()
    assert lambda_data["function_name"] == "ProcessEnvironmentalData"
    assert lambda_data["invocations_count"] >= 5
    assert lambda_data["last_duration_ms"] >= 0.0

    # 4. Verify Amazon CloudWatch alarms
    cw_res = client.get("/api/cloud/alarms")
    assert cw_res.status_code == 200
    cw_data = cw_res.json()
    assert "HighTemperatureAlarm" in cw_data["alarms"]
    assert "HighHumidityAlarm" in cw_data["alarms"]
    assert "SensorOfflineAlarm" in cw_data["alarms"]
    assert len(cw_data["history"]) > 0  # Alarm transitions occurred during packet 2 and 3


def test_dht11_range_validation():
    """Verify rejection of physical readings outside DHT11 operational envelope (0-50 C, 20-90 %RH)."""
    # Over-temperature packet (>50 C)
    bad_temp_packet = {
        "device_id": "esp32_env_node_01",
        "timestamp": time.time(),
        "packet_id": 991,
        "temperature_c": 58.0,  # Invalid
        "humidity_pct": 50.0,
        "wifi_rssi_dbm": -60,
        "sensor_status": "OK",
    }
    res = client.post("/api/device/publish", json=bad_temp_packet)
    assert res.status_code == 422
    assert "DHT11 physical boundary breach" in res.json()["detail"]

    # Under-humidity packet (<20 %RH)
    bad_rh_packet = {
        "device_id": "esp32_env_node_01",
        "timestamp": time.time(),
        "packet_id": 992,
        "temperature_c": 25.0,
        "humidity_pct": 12.0,  # Invalid
        "wifi_rssi_dbm": -60,
        "sensor_status": "OK",
    }
    res2 = client.post("/api/device/publish", json=bad_rh_packet)
    assert res2.status_code == 422
    assert "DHT11 physical boundary breach" in res2.json()["detail"]


def test_exports_csv_and_json():
    """Verify CSV and JSON datalake export endpoints."""
    # JSON export
    res_json = client.get("/api/export?format=json")
    assert res_json.status_code == 200
    data_json = res_json.json()
    assert data_json["bucket"] == "iot-environmental-datalake"
    assert data_json["record_count"] >= 5

    # CSV export
    res_csv = client.get("/api/export?format=csv")
    assert res_csv.status_code == 200
    assert "text/csv" in res_csv.headers["content-type"]
    csv_text = res_csv.text
    assert "temperature_c" in csv_text
    assert "humidity_pct" in csv_text
    assert "heat_index_c" in csv_text
    assert "esp32_env_node_01" in csv_text
