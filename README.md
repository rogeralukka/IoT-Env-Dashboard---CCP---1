# IoT-Env-Dashboard---CCP---1

# IoT Environmental Dashboard (Cloud Computing Project)

This repository contains the **IoT Environmental Dashboard** simulating an ESP32 + DHT11 + SSD1306 node publishing to a Virtual AWS cloud backend (AWS IoT Core, AWS Lambda, Amazon S3, and Amazon CloudWatch).

The complete project code and skeleton is located in the [`iot-env-dashboard/`](./iot-env-dashboard/) directory.

### Quick Start

```bash
# 1. Run Verification Test
python iot-env-dashboard/tests/quick_test.py

# 2. Run Pytest Suite
pytest iot-env-dashboard/tests -v

# 3. Start the FastAPI Backend
cd iot-env-dashboard
uvicorn backend.main:app --reload --port 8000
```

Refer to [`iot-env-dashboard/README.md`](./iot-env-dashboard/README.md) for full architecture specifications, endpoint documentation, and presentation demo scripts.
