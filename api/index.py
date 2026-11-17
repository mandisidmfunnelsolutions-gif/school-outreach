"""Vercel Python Serverless Function entrypoint."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from server import DispatchHandler  # noqa: E402


class handler(DispatchHandler):
    """Vercel BaseHTTPRequestHandler entrypoint (no WSGI app alias)."""
