"""
Weather Service (External Meteorological Integration).
AWS Architecture Mapping: Mimics external 3rd-party data provider integration
(e.g., AWS AppSync / API Gateway REST integration).
Fetches live weather from Open-Meteo API without authentication keys, caches responses
per city for 5 minutes, and falls back to a realistic diurnal curve if offline.
"""

import math
import time
from datetime import datetime, timezone
from typing import Dict, Any, Tuple, Optional
import httpx
from backend.services.lambda_processor import lambda_processor


class WeatherService:
    """
    Open-Meteo Integration with in-memory TTL caching and deterministic fallback simulation.
    """

    CITIES: Dict[str, Tuple[float, float]] = {
        "Hasanparthy (Hanamkonda)": (18.0681, 79.5236),
        "Hyderabad": (17.38, 78.48),
        "Warangal": (17.98, 79.60),
        "Bengaluru": (12.97, 77.59),
        "Delhi": (28.61, 77.21),
        "Mumbai": (19.08, 72.88),
    }

    CITY_METADATA: Dict[str, Dict[str, str]] = {
        "Hasanparthy (Hanamkonda)": {
            "pin_code": "506371",
            "coordinates_dms": "18°04′05″N 79°31′25″E",
            "district": "Hanamkonda District (SR University Campus)",
        },
        "Hyderabad": {"pin_code": "500001", "coordinates_dms": "17°22′48″N 78°28′48″E", "district": "Hyderabad"},
        "Warangal": {"pin_code": "506002", "coordinates_dms": "17°58′48″N 79°36′00″E", "district": "Warangal"},
        "Bengaluru": {"pin_code": "560001", "coordinates_dms": "12°58′12″N 77°35′24″E", "district": "Bengaluru Urban"},
        "Delhi": {"pin_code": "110001", "coordinates_dms": "28°36′36″N 77°12′36″E", "district": "New Delhi"},
        "Mumbai": {"pin_code": "400001", "coordinates_dms": "19°04′48″N 72°52′48″E", "district": "Mumbai City"},
    }

    # Baseline climatology per city for realistic mock diurnal curves
    CITY_CLIMATOLOGY: Dict[str, Dict[str, float]] = {
        "Hasanparthy (Hanamkonda)": {"mean_temp": 31.0, "temp_amp": 6.5, "mean_rh": 52.0, "rh_amp": 20.0},
        "Hyderabad": {"mean_temp": 30.0, "temp_amp": 6.0, "mean_rh": 55.0, "rh_amp": 20.0},
        "Warangal": {"mean_temp": 31.0, "temp_amp": 6.5, "mean_rh": 52.0, "rh_amp": 20.0},
        "Bengaluru": {"mean_temp": 24.5, "temp_amp": 5.0, "mean_rh": 68.0, "rh_amp": 18.0},
        "Delhi": {"mean_temp": 29.0, "temp_amp": 7.5, "mean_rh": 48.0, "rh_amp": 22.0},
        "Mumbai": {"mean_temp": 31.5, "temp_amp": 4.0, "mean_rh": 76.0, "rh_amp": 14.0},
    }

    CACHE_TTL_SECONDS = 300  # 5 minutes cache

    def __init__(self):
        # Cache storage: city_normalized -> {"data": dict, "cached_at": float}
        self.cache: Dict[str, Dict[str, Any]] = {}

    def _normalize_city_name(self, city: str) -> Optional[str]:
        """Finds matching standardized city name regardless of case or alias."""
        clean = city.strip().lower()
        if any(alias in clean for alias in ["hasanparthy", "hanamkonda", "506371", "sru", "sr university"]):
            return "Hasanparthy (Hanamkonda)"

        for standard_name in self.CITIES:
            if standard_name.lower() == clean or standard_name.lower().startswith(clean):
                return standard_name
        return None

    def _generate_mock_diurnal(self, city_name: str, lat: float, lon: float) -> Dict[str, Any]:
        """
        Generates a realistic 24-hour diurnal weather curve when external API fails.
        Temperature follows a sinusoidal curve peaking in early afternoon (~14:00)
        and reaching a minimum near dawn (~05:00). Humidity runs inversely.
        """
        clima = self.CITY_CLIMATOLOGY.get(
            city_name,
            {"mean_temp": 28.0, "temp_amp": 6.0, "mean_rh": 60.0, "rh_amp": 20.0}
        )

        now = datetime.now()
        current_hour = now.hour + (now.minute / 60.0)

        hourly_times = []
        hourly_temp = []
        hourly_rh = []

        for h in range(24):
            # Phase shift: lowest temp at h=5, peak at h=14
            phase = (h - 5) * (2 * math.pi / 24)
            temp = clima["mean_temp"] - clima["temp_amp"] * math.cos(phase)
            rh = clima["mean_rh"] + clima["rh_amp"] * math.cos(phase)
            hourly_times.append(f"{h:02d}:00")
            hourly_temp.append(round(temp, 1))
            hourly_rh.append(round(max(min(rh, 95.0), 15.0), 1))

        # Current conditions
        curr_phase = (current_hour - 5) * (2 * math.pi / 24)
        curr_temp = round(clima["mean_temp"] - clima["temp_amp"] * math.cos(curr_phase), 1)
        curr_rh = round(max(min(clima["mean_rh"] + clima["rh_amp"] * math.cos(curr_phase), 95.0), 15.0), 1)
        # Approximate apparent temperature
        apparent_temp = round(curr_temp + 0.33 * (curr_rh / 100 * 6.105 * math.exp(17.27 * curr_temp / (237.7 + curr_temp))) - 4.0, 1)

        # Psychrometric metrics
        hi_c = lambda_processor.calculate_heat_index(curr_temp, curr_rh)
        dp_c = lambda_processor.calculate_dew_point(curr_temp, curr_rh)
        ah_gm3 = lambda_processor.calculate_absolute_humidity(curr_temp, curr_rh)

        meta = self.CITY_METADATA.get(city_name, {"pin_code": "506371", "coordinates_dms": "", "district": city_name})
        t_max = round(clima["mean_temp"] + clima["temp_amp"], 1)
        t_min = round(clima["mean_temp"] - clima["temp_amp"], 1)

        return {
            "city": city_name,
            "coordinates": {"latitude": lat, "longitude": lon},
            "pin_code": meta.get("pin_code", "506371"),
            "coordinates_dms": meta.get("coordinates_dms", ""),
            "district": meta.get("district", city_name),
            "source": "mock",
            "cached_at": datetime.now(timezone.utc).isoformat(),
            "current": {
                "temperature_2m": curr_temp,
                "relative_humidity_2m": curr_rh,
                "apparent_temperature": apparent_temp,
                "heat_index_c": hi_c,
                "dew_point_c": dp_c,
                "absolute_humidity_gm3": ah_gm3,
                "pressure_msl": 1012.8,
                "wind_speed_10m": 12.6,
                "uv_index": 5.2,
                "precipitation_probability": 15.0,
            },
            "hourly": {
                "time": hourly_times,
                "temperature_2m": hourly_temp,
                "relative_humidity_2m": hourly_rh,
                "uv_index": [max(0.0, round(6.5 * math.sin(max(0, h - 6) * math.pi / 12), 1)) for h in range(24)],
                "precipitation_probability": [15 for _ in range(24)],
            },
            "daily": {
                "temperature_2m_max": t_max,
                "temperature_2m_min": t_min,
            },
        }

    async def get_weather(
        self,
        city: Optional[str] = None,
        lat: Optional[float] = None,
        lon: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Fetches live weather from Open-Meteo for the requested city or GPS coordinates.
        Returns cached data if within 5-minute TTL.
        Falls back to mock diurnal curve if network or upstream API fails.
        """
        if lat is not None and lon is not None:
            lat = round(float(lat), 4)
            lon = round(float(lon), 4)
            standard_city = "Device Location"
            cache_key = f"gps_{lat:.2f}_{lon:.2f}"
            meta = {
                "pin_code": "Auto-GPS",
                "coordinates_dms": f"{abs(lat):.2f}°{'N' if lat>=0 else 'S'} {abs(lon):.2f}°{'E' if lon>=0 else 'W'}",
                "district": "Auto-Detected via GPS",
            }
        else:
            if not city:
                city = "Hasanparthy (Hanamkonda)"
            standard_city = self._normalize_city_name(city)
            if not standard_city:
                standard_city = "Hasanparthy (Hanamkonda)"

            lat, lon = self.CITIES[standard_city]
            cache_key = standard_city.lower()
            meta = self.CITY_METADATA.get(standard_city, {"pin_code": "506371", "coordinates_dms": "", "district": standard_city})

        now_ts = time.time()

        # Check cache validity
        if cache_key in self.cache:
            entry = self.cache[cache_key]
            if now_ts - entry["cached_at_ts"] < self.CACHE_TTL_SECONDS:
                return entry["data"]

        # Fetch from Open-Meteo
        url = "https://api.open-meteo.com/v1/forecast"
        params = {
            "latitude": lat,
            "longitude": lon,
            "current": "temperature_2m,relative_humidity_2m,apparent_temperature,pressure_msl,wind_speed_10m",
            "hourly": "temperature_2m,relative_humidity_2m,uv_index,precipitation_probability",
            "daily": "temperature_2m_max,temperature_2m_min",
            "forecast_days": 1,
            "timezone": "auto",
        }

        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                response = await client.get(url, params=params)
                if response.status_code == 200:
                    data = response.json()
                    current = data.get("current", {})
                    hourly = data.get("hourly", {})
                    daily = data.get("daily", {})

                    curr_temp = float(current.get("temperature_2m", 28.0))
                    curr_rh = float(current.get("relative_humidity_2m", 60.0))
                    apparent_temp = float(current.get("apparent_temperature", curr_temp))
                    pressure_msl = float(current.get("pressure_msl", 1013.2))
                    wind_speed = float(current.get("wind_speed_10m", 12.0))

                    # Parse hourly data for today (first 24 items)
                    raw_times = hourly.get("time", [])[:24]
                    formatted_times = []
                    for t in raw_times:
                        # Extract "HH:MM"
                        if "T" in t:
                            formatted_times.append(t.split("T")[1][:5])
                        else:
                            formatted_times.append(t[-5:])

                    hourly_temp = [float(t) for t in hourly.get("temperature_2m", [])[:24]]
                    hourly_rh = [float(h) for h in hourly.get("relative_humidity_2m", [])[:24]]
                    hourly_uv = [float(u) for u in hourly.get("uv_index", [])[:24]]
                    hourly_rain = [float(p) for p in hourly.get("precipitation_probability", [])[:24]]

                    now_hour = min(23, max(0, datetime.now().hour))
                    curr_uv = hourly_uv[now_hour] if len(hourly_uv) > now_hour else 4.0
                    curr_rain = hourly_rain[now_hour] if len(hourly_rain) > now_hour else 0.0

                    daily_max = daily.get("temperature_2m_max", [])
                    daily_min = daily.get("temperature_2m_min", [])
                    t_max = float(daily_max[0]) if daily_max else (max(hourly_temp) if hourly_temp else curr_temp + 3.0)
                    t_min = float(daily_min[0]) if daily_min else (min(hourly_temp) if hourly_temp else curr_temp - 4.0)

                    # Computed psychrometric metrics
                    hi_c = lambda_processor.calculate_heat_index(curr_temp, curr_rh)
                    dp_c = lambda_processor.calculate_dew_point(curr_temp, curr_rh)
                    ah_gm3 = lambda_processor.calculate_absolute_humidity(curr_temp, curr_rh)

                    meta = self.CITY_METADATA.get(standard_city, {"pin_code": "506371", "coordinates_dms": "", "district": standard_city})

                    payload = {
                        "city": standard_city,
                        "coordinates": {"latitude": lat, "longitude": lon},
                        "pin_code": meta.get("pin_code", "506371"),
                        "coordinates_dms": meta.get("coordinates_dms", ""),
                        "district": meta.get("district", standard_city),
                        "source": "live",
                        "cached_at": datetime.now(timezone.utc).isoformat(),
                        "current": {
                            "temperature_2m": round(curr_temp, 1),
                            "relative_humidity_2m": round(curr_rh, 1),
                            "apparent_temperature": round(apparent_temp, 1),
                            "heat_index_c": hi_c,
                            "dew_point_c": dp_c,
                            "absolute_humidity_gm3": ah_gm3,
                            "pressure_msl": round(pressure_msl, 1),
                            "wind_speed_10m": round(wind_speed, 1),
                            "uv_index": round(curr_uv, 1),
                            "precipitation_probability": round(curr_rain, 0),
                        },
                        "hourly": {
                            "time": formatted_times,
                            "temperature_2m": hourly_temp,
                            "relative_humidity_2m": hourly_rh,
                            "uv_index": hourly_uv,
                            "precipitation_probability": hourly_rain,
                        },
                        "daily": {
                            "temperature_2m_max": round(t_max, 1),
                            "temperature_2m_min": round(t_min, 1),
                        },
                    }

                    # Save in cache
                    self.cache[cache_key] = {
                        "data": payload,
                        "cached_at_ts": now_ts,
                    }
                    return payload

        except Exception:
            # Fallback to mock on any network or timeout failure
            pass

        # Return mock diurnal curve
        mock_payload = self._generate_mock_diurnal(standard_city, lat, lon)
        self.cache[cache_key] = {
            "data": mock_payload,
            "cached_at_ts": now_ts,
        }
        return mock_payload


# Singleton instance for application-wide use
weather_service = WeatherService()
