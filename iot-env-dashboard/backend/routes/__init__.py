"""
Routes package initialization.
"""

from backend.routes.weather import router as weather_router
from backend.routes.device import router as device_router
from backend.routes.cloud import router as cloud_router
from backend.routes.export import router as export_router

__all__ = [
    "weather_router",
    "device_router",
    "cloud_router",
    "export_router",
]
