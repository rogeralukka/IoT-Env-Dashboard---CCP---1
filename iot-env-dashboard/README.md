# IoT Environmental Dashboard

A complete simulation of an enterprise IoT pipeline simulating an **ESP32 microcontroller with a DHT11 temperature/humidity sensor and SSD1306 OLED display** publishing to a **Virtual AWS Cloud Backend** (AWS IoT Core, AWS Lambda, Amazon S3, and Amazon CloudWatch).

---

## Architecture Overview & AWS Service Mapping

There is **no physical hardware required**. The backend emulates the full AWS event-driven cloud pipeline:

| Local Module | Emulated AWS Service | Description & Responsibility |
| :--- | :--- | :--- |
| `backend/services/iot_core.py` | **AWS IoT Core** | MQTT Message Broker on topic `iot/esp32/dht11/telemetry` (QoS 1). Buffers the last 50 messages and executes the Topic Rule that triggers Lambda. |
| `backend/services/lambda_processor.py` | **AWS Lambda** | Serverless function `ProcessEnvironmentalData`. Validates physical sensor ranges (DHT11: 0–50°C, 20–90% RH), computes Heat Index, Dew Point, and Absolute Humidity, checks alert thresholds, and dispatches to S3 & CloudWatch. |
| `backend/services/s3_store.py` | **Amazon S3** | Virtual object store for bucket `iot-environmental-datalake` in `backend/data/`. Manages timestamped JSON files and builds CSV / JSON exports. |
| `backend/services/cloudwatch.py` | **Amazon CloudWatch** | Maintains last 200 metric points. Evaluates `HighTemperatureAlarm` (>35°C), `HighHumidityAlarm` (>80%), and `SensorOfflineAlarm` (no packet for >10s). Tracks alarm transition history. |
| `backend/services/weather_service.py` | **External API / AppSync** | Connects to Open-Meteo API for Hyderabad, Warangal, Bengaluru, Delhi, and Mumbai with 5-minute caching and a synthetic diurnal curve fallback. |
| `backend/events.py` | **AWS EventBridge / SSE** | Server-Sent Events (SSE) broadcasting real-time sensor streams and alarm state transitions to the web interface. |

---

## Directory Structure

```text
iot-env-dashboard/
  frontend/                  # Vanilla HTML/CSS/JS frontend (Modes 1 & 2 built in Phases 2-3)
    index.html
    src/
      main.js
      api/
      modes/
        web/
        simulation/
      lib/
      styles/
  backend/                   # FastAPI Virtual AWS Backend
    main.py                  # App entry point, CORS, static mounting
    routes/
      weather.py             # GET /api/weather?city=...
      device.py              # POST /api/device/publish, GET /api/stream (SSE)
      cloud.py               # GET /api/cloud/{messages,s3,lambda,alarms}
      export.py              # GET /api/export?format=csv|json
    services/
      weather_service.py     # Open-Meteo integration & diurnal fallback
      iot_core.py            # AWS IoT Core simulation
      lambda_processor.py    # AWS Lambda ProcessEnvironmentalData simulation
      s3_store.py            # Amazon S3 datalake simulation
      cloudwatch.py          # Amazon CloudWatch metrics & alarms
    models/
      telemetry.py           # Pydantic data schemas
    data/                    # Virtual S3 bucket files (JSON)
  docs/
    architecture.md          # Architectural diagrams & details
  tests/
    test_backend.py          # Pytest automated test suite
    quick_test.py            # CLI verification script
  README.md
```

---

## Quickstart & Run Instructions

### 1. Prerequisites
- Python 3.11+
- Virtual environment with dependencies (`fastapi`, `uvicorn`, `httpx`, `pytest`)

### 2. Setup Virtual Environment & Install Dependencies
From the repository root:
```bash
# Using standard Python
python -m venv .venv
source .venv/bin/activate       # On Linux/macOS
.venv\Scripts\activate          # On Windows PowerShell

pip install fastapi "uvicorn[standard]" httpx pytest
```
*Or using `uv` (recommended for instant install):*
```bash
uv venv .venv
uv pip install --python .venv fastapi "uvicorn[standard]" httpx pytest
```

### 3. Run the Verification Tests
To run the automated verification script:
```bash
python iot-env-dashboard/tests/quick_test.py
```
Or run with pytest:
```bash
pytest iot-env-dashboard/tests -v
```

### 4. Start the Backend Server
```bash
cd iot-env-dashboard
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```
Open your browser to:
- **Interactive Swagger UI**: [http://localhost:8000/docs](http://localhost:8000/docs)
- **API Health & Service Discovery**: [http://localhost:8000/](http://localhost:8000/)

---

## API Endpoints Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/weather?city=Hyderabad` | Weather forecast (Open-Meteo, 5-min cache, fallback) |
| `POST` | `/api/device/publish` | Ingests ESP32 telemetry packet, triggers Lambda, S3, & CloudWatch |
| `GET` | `/api/stream` | Server-Sent Events (SSE) real-time event stream |
| `GET` | `/api/cloud/messages` | AWS IoT Core message broker history (last 50 packets) |
| `GET` | `/api/cloud/s3` | Amazon S3 bucket object list and storage metrics |
| `GET` | `/api/cloud/lambda` | AWS Lambda invocation stats, runtime logs, and durations |
| `GET` | `/api/cloud/alarms` | Amazon CloudWatch alarms status and transition history |
| `GET` | `/api/export?format=csv` | Exports S3 datalake readings as CSV |
| `GET` | `/api/export?format=json` | Exports S3 datalake readings as JSON |

---

## Telemetry Packet Format

```json
{
  "device_id": "esp32_env_node_01",
  "timestamp": 1728512400.0,
  "packet_id": 128,
  "temperature_c": 28.4,
  "humidity_pct": 65.0,
  "wifi_rssi_dbm": -58,
  "sensor_status": "OK"
}
```

---

## 3-Minute Presentation Demo Script (For College Evaluation)

1. **Architecture Introduction (30 seconds)**:
   > "In this project, we designed a serverless IoT environmental monitoring pipeline mimicking an AWS cloud setup. Because physical sensors are prone to supply and testbench variance, our backend emulates the actual cloud services: an ESP32 publishing MQTT QoS 1 packets to AWS IoT Core, a Topic Rule firing AWS Lambda, persistent object archiving in Amazon S3, and real-time alarming in Amazon CloudWatch."

2. **Demonstrate Telemetry Ingestion & Cloud Processing (1 minute)**:
   - Run the verification script: `python iot-env-dashboard/tests/quick_test.py`
   - Point out in the console output:
     - **Psychrometric Calculations**: Explain the Magnus formula for Dew Point, absolute humidity calculation, and the Rothfusz regression algorithm for Heat Index.
     - **Validation**: Show how an out-of-range temperature (e.g. 62°C) is rejected because the DHT11's physical specification is strictly 0–50°C and 20–90% RH.

3. **Demonstrate S3 Datalake & CloudWatch Alarms (1 minute)**:
   - Open [http://localhost:8000/docs](http://localhost:8000/docs) in the browser.
   - Execute `GET /api/cloud/s3`: show the generated JSON objects in bucket `iot-environmental-datalake`.
   - Execute `GET /api/cloud/alarms`: demonstrate that `HighTemperatureAlarm` tripped into `ALARM` state when packet #2 arrived at 38.2°C, and returned to `OK` when normal temperatures resumed.
   - Download the export via `GET /api/export?format=csv` to demonstrate datalake readiness for external analytics.
