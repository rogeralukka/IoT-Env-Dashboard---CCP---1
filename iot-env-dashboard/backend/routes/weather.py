"""
Weather API Route.
AWS Architecture Mapping: Mimics external weather data provider query endpoint.
Serves current and hourly weather for supported cities with caching and fallback simulation.
"""

from fastapi import APIRouter, Query
from typing import Dict, Any, Optional
from backend.services.weather_service import weather_service

router = APIRouter(prefix="/api/weather", tags=["Weather"])


@router.get("", summary="Get current and hourly weather for a city or GPS coordinates")
async def get_weather(
    city: Optional[str] = Query(None, description="Target city: Hasanparthy, Hyderabad, Warangal, etc."),
    lat: Optional[float] = Query(None, description="Latitude for device geolocation"),
    lon: Optional[float] = Query(None, description="Longitude for device geolocation"),
) -> Dict[str, Any]:
    """
    Returns live meteorological forecast from Open-Meteo with 5-minute server cache,
    or a synthetic diurnal curve fallback if upstream is unreachable.
    Supports either named city or device GPS coordinates (lat, lon).
    """
    data = await weather_service.get_weather(city=city, lat=lat, lon=lon)
    return data
