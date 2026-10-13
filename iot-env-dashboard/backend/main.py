"""
Main FastAPI Application for IoT Environmental Dashboard.
Simulates an end-to-end AWS IoT architecture:
- AWS IoT Core: MQTT ingestion & Topic Rules
- AWS Lambda: ProcessEnvironmentalData serverless function
- Amazon S3: Virtual datalake bucket (iot-environmental-datalake)
- Amazon CloudWatch: Time-series telemetry metrics and alarms
- Open-Meteo Integration: Real-time and diurnal weather forecasts
- Server-Sent Events (SSE): Push notifications for live dashboard
"""

import os
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from backend.routes.weather import router as weather_router
from backend.routes.device import router as device_router
from backend.routes.cloud import router as cloud_router
from backend.routes.export import router as export_router
from backend.services.cloudwatch import cloudwatch
from backend.services.s3_store import s3_store
from backend.services.iot_core import iot_core
from backend.services.lambda_processor import lambda_processor
from backend.events import broadcaster


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan manager.
    Resets session counters and datalake storage for a clean session.
    Hooks CloudWatch alarm transitions to the SSE real-time event bus.
    """
    # Reset all virtual AWS services for synchronized session startup
    s3_store.reset()
    iot_core.reset()
    lambda_processor.reset()
    cloudwatch.reset()

    # Wire CloudWatch alarm listener to dispatch SSE events
    def on_alarm_state_change(event_data):
        broadcaster.publish_nowait("alarm", event_data)

    cloudwatch.subscribe_alarm_listener(on_alarm_state_change)
    yield


app = FastAPI(
    title="IoT Environmental Dashboard - Virtual AWS Backend",
    description=(
        "Simulated Cloud Architecture for ESP32 + DHT11 + SSD1306 Environmental Node. "
        "Mimics AWS IoT Core, AWS Lambda, Amazon S3, and Amazon CloudWatch."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# Enable CORS for local development and web clients
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_no_cache_headers(request: Request, call_next):
    """Ensure browsers and proxies do not serve stale cached frontend files."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static") or path.startswith("/src"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


# Register API Routers
app.include_router(weather_router)
app.include_router(device_router)
app.include_router(cloud_router)
app.include_router(export_router)

# Locate frontend directory relative to backend/main.py
BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

if FRONTEND_DIR.exists():
    # Mount frontend directory for static assets
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")
    src_dir = FRONTEND_DIR / "src"
    if src_dir.exists():
        app.mount("/src", StaticFiles(directory=str(src_dir)), name="src")


@app.get("/api", summary="API service discovery status")
def api_status():
    """Returns API service discovery status and endpoints map."""
    return {
        "project": "IoT Environmental Dashboard",
        "phase": "Phase 1 - Backend & Virtual AWS Services Active",
        "status": "ONLINE",
        "documentation": "/docs",
        "endpoints": {
            "weather": "/api/weather?city=Hyderabad",
            "device_publish": "POST /api/device/publish",
            "stream_sse": "GET /api/stream",
            "cloud_iot_messages": "/api/cloud/messages",
            "cloud_s3_datalake": "/api/cloud/s3",
            "cloud_lambda_metrics": "/api/cloud/lambda",
            "cloud_cloudwatch_alarms": "/api/cloud/alarms",
            "datalake_export": "/api/export?format=csv|json",
        },
        "virtual_aws_services": {
            "aws_iot_core": "Topic iot/esp32/dht11/telemetry (QoS 1)",
            "aws_lambda": "ProcessEnvironmentalData (validation & psychrometrics)",
            "amazon_s3": "Bucket iot-environmental-datalake (backend/data/)",
            "amazon_cloudwatch": "HighTemperatureAlarm, HighHumidityAlarm, SensorOfflineAlarm",
        }
    }


@app.get("/", summary="Root endpoint - serves dashboard or API status")
def root(request: Request):
    """
    Serves frontend index.html if present; if JSON requested, returns discovery info.
    """
    accept = request.headers.get("accept", "")
    if "application/json" in accept and "text/html" not in accept:
        return api_status()

    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists() and index_file.stat().st_size > 0:
        return FileResponse(str(index_file))

    return api_status()
