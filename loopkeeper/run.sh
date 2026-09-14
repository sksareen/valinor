#!/bin/bash
# Standalone Loopkeeper (usually unnecessary — Valinor server.js starts it).
set -e
cd "$(dirname "$0")"

if [ ! -d venv ]; then
  echo "Creating venv (prefers python3.12)…"
  PY=python3.12
  command -v "$PY" >/dev/null 2>&1 || PY=python3.11
  command -v "$PY" >/dev/null 2>&1 || PY=python3
  "$PY" -m venv venv
  ./venv/bin/pip install -r requirements.txt
fi
# shellcheck disable=SC1091
source venv/bin/activate

if [ ! -f .env ]; then
  cp env.example .env
fi

PORT="${PORT:-18003}"
if lsof -iTCP:"$PORT" -sTCP:LISTEN -P >/dev/null 2>&1; then
  echo "Port $PORT already in use (Valinor may already own Loopkeeper)."
  exit 1
fi

export PORT HOST="${HOST:-127.0.0.1}"
exec python start_embedded.py
