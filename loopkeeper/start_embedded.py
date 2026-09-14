#!/usr/bin/env python3
"""Embedded Loopkeeper entrypoint for Valinor (no reload, loopback only)."""
import os
import sys

backend_dir = os.path.dirname(os.path.abspath(__file__))
os.chdir(backend_dir)
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import uvicorn

if __name__ == "__main__":
    port = int(os.getenv("PORT", "18003"))
    host = os.getenv("HOST", "127.0.0.1")
    print(f"Loopkeeper (embedded) on http://{host}:{port}", flush=True)
    uvicorn.run("main:app", host=host, port=port, reload=False, log_level="info")
