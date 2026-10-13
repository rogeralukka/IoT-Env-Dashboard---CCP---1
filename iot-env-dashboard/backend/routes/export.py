"""
Export API Route.
AWS Architecture Mapping: Mimics Amazon S3 Athena / Data Export service.
Provides CSV and JSON dataset exports of telemetry stored in the S3 datalake.
"""

from fastapi import APIRouter, Query, Response
from fastapi.responses import JSONResponse
from backend.services.s3_store import s3_store

router = APIRouter(prefix="/api/export", tags=["Data Lake Export"])


@router.get("", summary="Export persisted telemetry dataset as CSV or JSON")
def export_telemetry_data(
    format: str = Query("json", description="Export file format: 'csv' or 'json'")
):
    """
    Exports all records from the virtual Amazon S3 datalake 'iot-environmental-datalake'.
    Supports CSV and JSON formats with appropriate attachment headers.
    """
    format_clean = format.strip().lower()

    if format_clean == "csv":
        csv_content = s3_store.export_all_readings_csv()
        return Response(
            content=csv_content,
            media_type="text/csv",
            headers={
                "Content-Disposition": 'attachment; filename="iot_environmental_datalake_export.csv"'
            },
        )

    # Default to JSON export
    json_data = s3_store.export_all_readings_json()
    return JSONResponse(
        content={
            "bucket": s3_store.BUCKET_NAME,
            "record_count": len(json_data),
            "records": json_data,
        },
        headers={
            "Content-Disposition": 'attachment; filename="iot_environmental_datalake_export.json"'
        },
    )
