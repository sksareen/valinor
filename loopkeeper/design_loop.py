#!/usr/bin/env python3
"""
Design hill-climb for Loops UI (mirror of autoresearch.py, applied to UX).

States: BASELINE → PROPOSE → APPLY → MEASURE → VERIFY → (KEEP | DISCARD) → repeat

- PROPOSE: one small reversible variant (single git commit on loops.html)
- VERIFY: accept iff primary metric improved AND no guardrail regressed
  Guardrails: completion_rate (must not drop), abandon_rate (must not rise)
- DISCARD: git revert of the cycle commit
- Every 5th cycle: random_restart=true (bigger variant, same verify rule)

Metrics are noisy (single user). MEASURE always pairs quantitative aggregate
with a structured qualitative note — never fabricate significance on thin data.

Usage examples:
  uv run python design_loop.py status
  uv run python design_loop.py baseline
  uv run python design_loop.py measure --qualitative "feels faster to act" --primary median_time_to_first_action
  uv run python design_loop.py verify --primary median_time_to_first_action
  uv run python design_loop.py cycle1-chrome  # record chrome-removal as cycle 1 KEEP
"""
from __future__ import annotations

import argparse
import json
import subprocess
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]  # valinor repo root
OUT_DIR = ROOT / "design_runs"
LOG_PATH = OUT_DIR / "log.jsonl"
STATE_PATH = OUT_DIR / "state.json"
PEAK_PATH = OUT_DIR / "current_peak.json"
UI_FILE = "chat/backend/static/loops.html"

GUARDRAILS = ("completion_rate", "abandon_rate")
# abandon_rate is derived as max of abandon_rate_by_stage values


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _load_state() -> Dict[str, Any]:
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    return {
        "cycle": 0,
        "phase": "BASELINE",
        "primary_metric": "median_time_to_first_action",
        "pending_commit": None,
        "pending_before": None,
        "random_restart_next": False,
    }


def _save_state(state: Dict[str, Any]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def _append_log(entry: Dict[str, Any]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def fetch_metrics(base: str) -> dict:
    url = base.rstrip("/") + "/metrics/loops"
    with urllib.request.urlopen(url, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def snapshot(base: str, label: str = "", qualitative: str = "", cycle: Optional[int] = None) -> dict:
    metrics = fetch_metrics(base)
    ts = _now()
    suffix = f"_{label}" if label else ""
    path = OUT_DIR / f"baseline_{ts}{suffix}.json"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "ts": ts,
        "base": base,
        "label": label or None,
        "cycle": cycle,
        "qualitative": qualitative or None,
        "metrics": metrics,
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    PEAK_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return payload


def _abandon_score(metrics: dict) -> Optional[float]:
    """Higher = worse. Max stage abandon rate; None if no data."""
    by = metrics.get("abandon_rate_by_stage") or {}
    vals = [v for v in by.values() if v is not None]
    if not vals:
        return None
    return float(max(vals))


def _metric_value(metrics: dict, name: str) -> Optional[float]:
    if name == "abandon_rate":
        return _abandon_score(metrics)
    v = metrics.get(name)
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _improved(primary: str, before: Optional[float], after: Optional[float]) -> Optional[bool]:
    """
    Direction: completion_rate higher is better; time/taps/abandon lower is better.
    Returns None if either side missing (cannot claim significance).
    """
    if before is None or after is None:
        return None
    higher_better = primary in ("completion_rate",)
    if higher_better:
        return after > before
    return after < before


def _guardrail_ok(before_m: dict, after_m: dict) -> Tuple[bool, List[str]]:
    reasons: List[str] = []
    # completion_rate must not drop (None → skip)
    b_cr = _metric_value(before_m, "completion_rate")
    a_cr = _metric_value(after_m, "completion_rate")
    if b_cr is not None and a_cr is not None and a_cr < b_cr:
        reasons.append(f"completion_rate regressed {b_cr} → {a_cr}")

    b_ab = _abandon_score(before_m)
    a_ab = _abandon_score(after_m)
    if b_ab is not None and a_ab is not None and a_ab > b_ab:
        reasons.append(f"abandon_rate regressed {b_ab} → {a_ab}")

    return (len(reasons) == 0, reasons)


def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=str(REPO),
        capture_output=True,
        text=True,
        check=False,
    )


def cmd_status(args: argparse.Namespace) -> None:
    state = _load_state()
    peak = None
    if PEAK_PATH.exists():
        peak = json.loads(PEAK_PATH.read_text(encoding="utf-8"))
    print(
        json.dumps(
            {
                "state": state,
                "peak": peak,
                "log": str(LOG_PATH),
                "next_random_restart": (state.get("cycle", 0) + 1) % 5 == 0,
            },
            indent=2,
        )
    )


def cmd_baseline(args: argparse.Namespace) -> None:
    state = _load_state()
    payload = snapshot(args.base, label=args.label or "baseline", qualitative=args.qualitative)
    state["phase"] = "PROPOSE"
    state["pending_before"] = payload
    _save_state(state)
    print(json.dumps(payload, indent=2))


def cmd_propose(args: argparse.Namespace) -> None:
    """Record proposal metadata; APPLY is a human/agent git commit of one UI variable."""
    state = _load_state()
    cycle = int(state.get("cycle", 0)) + 1
    random_restart = cycle % 5 == 0
    state["cycle"] = cycle
    state["phase"] = "PROPOSE"
    state["random_restart_next"] = random_restart
    state["proposal"] = {
        "variable": args.variable,
        "description": args.description,
        "random_restart": random_restart,
        "primary_metric": args.primary or state.get("primary_metric"),
    }
    if args.primary:
        state["primary_metric"] = args.primary
    _save_state(state)
    print(
        json.dumps(
            {
                "phase": "PROPOSE",
                "cycle": cycle,
                "random_restart": random_restart,
                "proposal": state["proposal"],
                "hint": (
                    "Bigger variant this cycle (random restart)."
                    if random_restart
                    else "Change exactly one design variable in loops.html, then: design_loop.py apply"
                ),
            },
            indent=2,
        )
    )


def cmd_apply(args: argparse.Namespace) -> None:
    """Commit current loops.html change as the cycle's single reversible variant."""
    state = _load_state()
    msg = args.message or (
        f"design cycle {state.get('cycle', '?')}: "
        f"{(state.get('proposal') or {}).get('variable', 'ui variant')}"
    )
    add = _git("add", "--", UI_FILE)
    if add.returncode != 0:
        raise SystemExit(add.stderr or add.stdout)
    commit = _git("commit", "-m", msg)
    if commit.returncode != 0:
        # maybe nothing to commit — still allow measuring existing tip
        if "nothing to commit" in (commit.stdout + commit.stderr).lower():
            head = _git("rev-parse", "HEAD")
            state["pending_commit"] = head.stdout.strip()
            state["phase"] = "MEASURE"
            state["apply_note"] = "nothing_to_commit_using_HEAD"
            _save_state(state)
            print(json.dumps({"phase": "MEASURE", "commit": state["pending_commit"], "note": "nothing to commit"}, indent=2))
            return
        raise SystemExit(commit.stderr or commit.stdout)
    head = _git("rev-parse", "HEAD")
    state["pending_commit"] = head.stdout.strip()
    state["phase"] = "MEASURE"
    if not state.get("pending_before"):
        state["pending_before"] = snapshot(args.base, label="pre_apply", cycle=state.get("cycle"))
    _save_state(state)
    print(json.dumps({"phase": "MEASURE", "commit": state["pending_commit"]}, indent=2))


def cmd_measure(args: argparse.Namespace) -> None:
    state = _load_state()
    after = snapshot(
        args.base,
        label=f"cycle{state.get('cycle', 0)}_after",
        qualitative=args.qualitative,
        cycle=state.get("cycle"),
    )
    state["pending_after"] = after
    state["phase"] = "VERIFY"
    if args.primary:
        state["primary_metric"] = args.primary
    _save_state(state)
    print(
        json.dumps(
            {
                "phase": "VERIFY",
                "qualitative": args.qualitative,
                "thin_data": (after.get("metrics") or {}).get("thin_data"),
                "metrics": after.get("metrics"),
                "note": "Run design_loop.py verify next. Thin data → treat KEEP as provisional.",
            },
            indent=2,
        )
    )


def cmd_verify(args: argparse.Namespace) -> None:
    state = _load_state()
    primary = args.primary or state.get("primary_metric") or "median_time_to_first_action"
    before_wrap = state.get("pending_before") or (
        json.loads(PEAK_PATH.read_text(encoding="utf-8")) if PEAK_PATH.exists() else None
    )
    after_wrap = state.get("pending_after")
    if not after_wrap:
        raise SystemExit("No pending_after — run measure first")
    before_m = (before_wrap or {}).get("metrics") or {}
    after_m = after_wrap.get("metrics") or {}

    b_val = _metric_value(before_m, primary)
    a_val = _metric_value(after_m, primary)
    improved = _improved(primary, b_val, a_val)
    guards_ok, guard_reasons = _guardrail_ok(before_m, after_m)
    thin = bool(after_m.get("thin_data") or before_m.get("thin_data"))

    # Decision: KEEP only if improved AND guards OK.
    # If either side null → cannot claim improvement → DISCARD unless --force-keep
    if args.force_keep:
        decision = "KEEP"
        reason = "force_keep"
    elif improved is True and guards_ok:
        decision = "KEEP"
        reason = "primary_improved_guards_ok"
    elif improved is None:
        decision = "DISCARD" if not args.keep_on_thin else "KEEP"
        reason = "thin_or_missing_metric" + ("_kept_provisional" if decision == "KEEP" else "")
        if not guards_ok:
            decision = "DISCARD"
            reason = "guardrail_regression:" + ",".join(guard_reasons)
    else:
        decision = "DISCARD"
        reason = "no_improvement" if improved is False else "guardrail:" + ",".join(guard_reasons)
        if not guards_ok:
            decision = "DISCARD"
            reason = "guardrail_regression:" + ",".join(guard_reasons)

    entry = {
        "ts": _now(),
        "cycle": state.get("cycle"),
        "phase": "VERIFY",
        "metric": primary,
        "before": b_val,
        "after": a_val,
        "decision": decision,
        "reason": reason,
        "random_restart": bool((state.get("proposal") or {}).get("random_restart")),
        "qualitative": after_wrap.get("qualitative"),
        "thin_data": thin,
        "commit": state.get("pending_commit"),
        "proposal": state.get("proposal"),
        "guard_reasons": guard_reasons,
    }
    _append_log(entry)

    if decision == "DISCARD" and state.get("pending_commit") and not args.dry_run:
        # Revert the cycle commit if it is HEAD
        head = _git("rev-parse", "HEAD").stdout.strip()
        if head == state["pending_commit"]:
            rev = _git("revert", "--no-edit", state["pending_commit"])
            if rev.returncode != 0:
                # fallback soft: checkout file from parent
                _git("checkout", f"{state['pending_commit']}^", "--", UI_FILE)
                _git("commit", "-m", f"design cycle {state.get('cycle')}: DISCARD revert UI")
            entry["reverted"] = True
        else:
            entry["reverted"] = False
            entry["revert_note"] = "pending_commit is not HEAD; skipped auto-revert"
        _append_log({**entry, "phase": "DISCARD"})
        state["phase"] = "PROPOSE"
    else:
        # KEEP — after snapshot becomes new peak
        PEAK_PATH.write_text(json.dumps(after_wrap, indent=2) + "\n", encoding="utf-8")
        _append_log({**entry, "phase": "KEEP"})
        state["phase"] = "PROPOSE"
        state["pending_before"] = after_wrap

    state["pending_after"] = None
    state["pending_commit"] = None
    state["last_decision"] = entry
    _save_state(state)
    print(json.dumps(entry, indent=2))


def cmd_cycle1_chrome(args: argparse.Namespace) -> None:
    """
    Record the redundant-chrome removal (guided hides stage/meta/timeline/composer)
    as cycle 1 on the log. Instrumentation + baseline first; this is the first
    before/after on record. Quantitative before is empty/null; KEEP is provisional
    with qualitative note (attribution: one variable = guided chrome visibility).
    """
    state = _load_state()
    before = snapshot(
        args.base,
        label="cycle0_pre_chrome",
        qualitative="pre chrome-removal baseline (often empty metrics)",
        cycle=0,
    )
    state["cycle"] = 1
    state["primary_metric"] = args.primary or "median_time_to_first_action"
    state["proposal"] = {
        "variable": "guided_chrome_visibility",
        "description": (
            "Guided mode hides stage strip, meta row, timeline, composer — "
            "coach card + ring only"
        ),
        "random_restart": False,
    }
    after = snapshot(
        args.base,
        label="cycle1_chrome_removal",
        qualitative=args.qualitative
        or (
            "Removed redundant debug chrome in guided view. One variable: "
            "visibility of /runs debug chrome while guided=true. Feels clearer; "
            "metrics still thin — provisional KEEP pending real traffic."
        ),
        cycle=1,
    )
    entry = {
        "ts": _now(),
        "cycle": 1,
        "phase": "KEEP",
        "metric": state["primary_metric"],
        "before": _metric_value(before["metrics"], state["primary_metric"]),
        "after": _metric_value(after["metrics"], state["primary_metric"]),
        "decision": "KEEP",
        "reason": "cycle1_bootstrap_chrome_removal_qualitative",
        "random_restart": False,
        "qualitative": after.get("qualitative"),
        "thin_data": True,
        "commit": None,
        "proposal": state["proposal"],
        "note": (
            "Chrome removal already applied in loops.html. Quantitative before/after "
            "may be null until events accrue; KEEP is qualitative/provisional."
        ),
    }
    _append_log(entry)
    state["phase"] = "PROPOSE"
    state["pending_before"] = after
    state["pending_after"] = None
    state["last_decision"] = entry
    _save_state(state)
    print(json.dumps(entry, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="Loops UI design hill-climb")
    parser.add_argument("--base", default="http://127.0.0.1:8013")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status")
    p_base = sub.add_parser("baseline")
    p_base.add_argument("--label", default="baseline")
    p_base.add_argument("--qualitative", default="")

    p_prop = sub.add_parser("propose")
    p_prop.add_argument("--variable", required=True)
    p_prop.add_argument("--description", default="")
    p_prop.add_argument("--primary", default=None)

    p_apply = sub.add_parser("apply")
    p_apply.add_argument("--message", default=None)

    p_meas = sub.add_parser("measure")
    p_meas.add_argument("--qualitative", required=True)
    p_meas.add_argument("--primary", default=None)

    p_ver = sub.add_parser("verify")
    p_ver.add_argument("--primary", default=None)
    p_ver.add_argument("--force-keep", action="store_true")
    p_ver.add_argument("--keep-on-thin", action="store_true")
    p_ver.add_argument("--dry-run", action="store_true")

    p_c1 = sub.add_parser("cycle1-chrome")
    p_c1.add_argument("--primary", default="median_time_to_first_action")
    p_c1.add_argument("--qualitative", default="")

    args = parser.parse_args()
    # propagate --base onto subcommands
    if not hasattr(args, "base"):
        args.base = "http://127.0.0.1:8013"

    cmds = {
        "status": cmd_status,
        "baseline": cmd_baseline,
        "propose": cmd_propose,
        "apply": cmd_apply,
        "measure": cmd_measure,
        "verify": cmd_verify,
        "cycle1-chrome": cmd_cycle1_chrome,
    }
    cmds[args.cmd](args)


if __name__ == "__main__":
    main()
