"""Vercel Python Serverless Function entrypoint."""

import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from server import DispatchHandler as handler, app, application  # noqa: E402,F401
