"""
Backend services package initialization.
"""

from backend.services.s3_store import s3_store, S3StoreService
from backend.services.cloudwatch import cloudwatch, CloudWatchService
from backend.services.lambda_processor import lambda_processor, LambdaProcessorService, ValidationError
from backend.services.iot_core import iot_core, IoTCoreService
from backend.services.weather_service import weather_service, WeatherService

__all__ = [
    "s3_store",
    "S3StoreService",
    "cloudwatch",
    "CloudWatchService",
    "lambda_processor",
    "LambdaProcessorService",
    "ValidationError",
    "iot_core",
    "IoTCoreService",
    "weather_service",
    "WeatherService",
]
