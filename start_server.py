"""
Standalone Server Starter for IoT Environmental Dashboard.
Runs FastAPI backend on http://127.0.0.1:8000.
"""

import sys
from pathlib import Path

# Add iot-env-dashboard to sys.path
project_dir = Path(__file__).resolve().parent / "iot-env-dashboard"
if str(project_dir) not in sys.path:
    sys.path.insert(0, str(project_dir))

from backend.main import app
import uvicorn

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
