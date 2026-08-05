#!/usr/bin/env python3
"""
Snapshot current /metrics/loops as a timestamped JSON peak file in design_runs/.

Usage:
  uv run python design_baseline.py
  uv run python design_baseline.py --base http://127.0.0.1:8013
  uv run python design_baseline.py --label chrome_removal_cycle1 --qualitative "guided hides debug chrome"
"""
from __future__ import annotations

import argparse
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "design_runs"


def fetch_metrics(base: str) -> dict:
    url = base.rstrip("/") + "/metrics/loops"
    with urllib.request.urlopen(url, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description="Dump Loops UX metrics baseline")
    parser.add_argument("--base", default="http://127.0.0.1:8013")
    parser.add_argument("--label", default="")
    parser.add_argument("--qualitative", default="")
    parser.add_argument("--cycle", type=int, default=None)
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    metrics = fetch_metrics(args.base)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    suffix = f"_{args.label}" if args.label else ""
    path = OUT_DIR / f"baseline_{ts}{suffix}.json"

    payload = {
        "ts": ts,
        "base": args.base,
        "label": args.label or None,
        "cycle": args.cycle,
        "qualitative": args.qualitative or None,
        "metrics": metrics,
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    # Also refresh "current peak" pointer for the design loop
    peak = OUT_DIR / "current_peak.json"
    peak.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({"wrote": str(path), "peak": str(peak), "metrics": metrics}, indent=2))


if __name__ == "__main__":
    main()
