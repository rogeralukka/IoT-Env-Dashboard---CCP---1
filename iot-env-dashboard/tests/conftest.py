"""
Pytest configuration and environment setup.
Ensures iot-env-dashboard is on the Python module search path.
"""

import sys
from pathlib import Path

# Add iot-env-dashboard root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
