# IoT Environmental Dashboard: Architecture & AWS Simulation

This project simulates a complete enterprise cloud IoT architecture on AWS without requiring physical hardware or paid cloud accounts.

```
+-------------------------------------------------------------+
|                      Simulated Device                       |
|         ESP32 Microcontroller + DHT11 Temp/Humidity         |
|              + SSD1306 128x64 I2C OLED Display              |
+-------------------------------------------------------------+
                              |
                     POST /api/device/publish
                   (MQTT Topic: iot/esp32/dht11/telemetry)
                              v
+-------------------------------------------------------------+
|                      AWS IoT Core                           |
|  - Message Broker (buffers last 50 packets)                 |
|  - Topic Rules Engine (SELECT * FROM 'iot/.../telemetry')   |
+-------------------------------------------------------------+
                              |
                       Triggers Action
                              v
+-------------------------------------------------------------+
|                       AWS Lambda                            |
|             Function: ProcessEnvironmentalData              |
|  - Validation: DHT11 bounds (0-50 C, 20-90 %RH)             |
|  - Psychrometric Formulas:                                  |
|      * Dew Point (Magnus-Tetens)                            |
|      * Absolute Humidity (g/m3)                             |
|      * Heat Index (Rothfusz regression with adjustments)    |
|  - Alert Evaluation: high_temp (>35C), high_humidity (>80%) |
+-------------------------------------------------------------+
                 /                           \
                v                             v
+-------------------------------+ +--------------------------------+
|           Amazon S3           | |        Amazon CloudWatch       |
| Bucket:                       | | - Last 200 metric points buffer|
| iot-environmental-datalake    | | - Operational Alarms:          |
| - Timestamped JSON files      | |   * HighTemperatureAlarm (>35C)|
| - CSV / JSON export engine    | |   * HighHumidityAlarm (>80%)   |
|                               | |   * SensorOfflineAlarm (>10s)  |
|                               | | - Alarm state transition log   |
+-------------------------------+ +--------------------------------+
                                              |
                                              v
                              +--------------------------------+
                              |       Server-Sent Events       |
                              |         GET /api/stream        |
                              | Real-time push to web UI       |
                              +--------------------------------+
```

## Cloud Service Mapping Table

| Local Module | Emulated AWS Service | Key Simulated Responsibilities |
| :--- | :--- | :--- |
| `backend/services/iot_core.py` | **AWS IoT Core** | MQTT message ingestion on `iot/esp32/dht11/telemetry` (QoS 1), retains 50 messages, executes Topic Rule to invoke Lambda. |
| `backend/services/lambda_processor.py` | **AWS Lambda** | Executes serverless function `ProcessEnvironmentalData`. Validates DHT11 ranges, calculates Dew Point, Heat Index, and Absolute Humidity. Logs execution time and memory profile. |
| `backend/services/s3_store.py` | **Amazon S3** | Object storage in bucket `iot-environmental-datalake` (`backend/data/`). Generates batch CSV/JSON exports. |
| `backend/services/cloudwatch.py` | **Amazon CloudWatch** | Ingests time-series metrics (200 points). Evaluates threshold alarms: High Temperature, High Humidity, Sensor Offline (10s threshold). |
| `backend/services/weather_service.py` | **AWS AppSync / External API** | Integrates external Open-Meteo weather API with 5-minute server cache and diurnal fallback curve. |
| `backend/events.py` | **AWS IoT Core SSE Bridge** | Streams telemetry and alarm transitions to connected browsers in real-time. |
