"""Muse connector — inbound missions + completion reports.

Inbound: Muse POSTs already-framed missions. They skip embed/cluster/LLM
and merge into the surfaced list with origin=muse.

Outbound: when a loop that started from a Muse mission closes, POST a
completion report to MUSE_WEBHOOK_URL. Failures go to a dead-letter file
so a Muse outage never blocks closing a loop.

Execute-via-Muse (hand an AI step to Muse) is later — see
MUSE_INTEGRATION.md §6b. `execute_supported()` stays False until then.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

# Execute-via-Muse is later. /api/deck/assist stays internal until a target picker lands.
def execute_supported() -> bool:
    return False


def _store_path() -> str:
    return os.getenv("MUSE_STORE_PATH") or os.path.join(
        os.path.expanduser("~/.cache"), "valinor-muse-missions.json"
    )


def _deadletter_path() -> str:
    return os.getenv("MUSE_DEADLETTER_PATH") or os.path.join(
        os.path.expanduser("~/.cache"), "valinor-muse-deadletter.jsonl"
    )


def _load() -> List[Dict[str, Any]]:
    try:
        with open(_store_path(), encoding="utf-8") as f:
            data = json.load(f)
        rows = data.get("missions") if isinstance(data, dict) else data
        return list(rows) if isinstance(rows, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _save(rows: List[Dict[str, Any]]) -> None:
    path = _store_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"missions": rows}, f)
    except OSError as e:
        logger.warning("muse store write failed (%s): %s", path, e)


def inbound_authorized(authorization: str = "", x_muse_key: str = "") -> bool:
    key = os.getenv("MUSE_INBOUND_KEY", "")
    if not key:
        return True
    got = ""
    if authorization.lower().startswith("bearer "):
        got = authorization[7:].strip()
    elif x_muse_key:
        got = x_muse_key.strip()
    return bool(got) and got == key


def upsert_missions(raw: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Insert or refresh inbound Muse missions. Status stays open unless already closed."""
    now = datetime.now(timezone.utc).isoformat()
    rows = _load()
    by_id = {str(r.get("muse_id") or ""): r for r in rows if r.get("muse_id")}
    added, updated = 0, 0
    for item in raw:
        mid = str(item.get("muse_id") or "").strip()
        title = str(item.get("title") or "").strip()
        if not mid or not title:
            continue
        theme = str(item.get("theme") or title).strip()
        rec = {
            "muse_id": mid,
            "title": title[:70],
            "outcome": str(item.get("outcome") or "").strip(),
            "theme": theme,
            "comment": str(item.get("comment") or "").strip(),
            "why_now": str(item.get("why_now") or "").strip(),
            "priority": item.get("priority"),
            "received_at": now,
        }
        prev = by_id.get(mid)
        if prev:
            # Muse is the authority: a new push means the mission is current again.
            rec["status"] = "open"
            rec["loop_id"] = prev.get("loop_id")
            rec["received_at"] = prev.get("received_at") or now
            rec["updated_at"] = now
            by_id[mid] = rec
            updated += 1
        else:
            rec["status"] = "open"
            rec["loop_id"] = None
            by_id[mid] = rec
            added += 1
    # keep original order, append new
    seen = set()
    out = []
    for r in rows:
        mid = str(r.get("muse_id") or "")
        if mid in by_id and mid not in seen:
            out.append(by_id[mid])
            seen.add(mid)
    for mid, r in by_id.items():
        if mid not in seen:
            out.append(r)
    _save(out[-400:])
    return {"added": added, "updated": updated, "open": sum(1 for r in out if r.get("status") == "open")}


def mark_status(muse_id: str = "", title: str = "", status: str = "consumed",
                loop_id: str = "", why: str = "") -> bool:
    rows = _load()
    hit = False
    want_title = (title or "").strip().lower()
    for r in rows:
        if muse_id and str(r.get("muse_id") or "") == muse_id:
            hit = True
        elif want_title and str(r.get("title") or "").strip().lower() == want_title:
            hit = True
        else:
            continue
        r["status"] = status
        if loop_id:
            r["loop_id"] = loop_id
        if why:
            r["why"] = why
        r["closed_at"] = datetime.now(timezone.utc).isoformat()
    if hit:
        _save(rows)
    return hit


def surfaced_missions() -> List[Dict[str, Any]]:
    """Open Muse missions in the same shape as ingest-surfaced ones."""
    open_rows = [r for r in _load() if (r.get("status") or "open") == "open"]

    def sort_key(r: Dict[str, Any]):
        p = r.get("priority")
        try:
            pri = int(p)
        except (TypeError, ValueError):
            pri = 99
        return (pri, r.get("received_at") or "")

    open_rows.sort(key=sort_key)
    out = []
    for r in open_rows:
        mid = str(r.get("muse_id") or "")
        why = str(r.get("why_now") or "")
        out.append({
            "id": "muse-" + mid,
            "muse_id": mid,
            "origin": "muse",
            "icon": "muse",
            "title": r.get("title") or "",
            "outcome": r.get("outcome") or "",
            "theme": r.get("theme") or r.get("title") or "",
            "comment": r.get("comment") or "",
            "why_now": why,
            "signals": [{"id": mid, "source": "muse", "title": why or "from Muse", "date": ""}],
            "cluster_size": 1,
            "priority": r.get("priority"),
        })
    return out


def connector_status() -> str:
    """Live when inbound is wired. Closes are pulled by Muse (poll), not pushed."""
    if os.getenv("MUSE_INBOUND_KEY", "").strip() or _load():
        return "live"
    return "offline"


def public_api_base(host: str = "") -> str:
    forced = (os.getenv("VALINOR_PUBLIC_URL") or os.getenv("MUSE_PUBLIC_BASE") or "").strip().rstrip("/")
    if forced:
        return forced
    h = (host or "").split(",")[0].strip()
    if "tryvalinor.com" in h.lower() or os.getenv("VALINOR_GATE", "").strip():
        return "https://api.tryvalinor.com"
    # Hub proxies /api to loopkeeper and rewrites Host to :18003.
    if (not h) or h.startswith("127.0.0.1") or h.startswith("localhost") or ":18003" in h:
        return "http://127.0.0.1:4777"
    return "http://" + h


def connect_instructions(host: str = "") -> Dict[str, Any]:
    """Paste-to-Muse card. Key is included so the human can copy one blob."""
    base = public_api_base(host)
    key = os.getenv("MUSE_INBOUND_KEY", "").strip()
    auth = (
        f"Authorization: Bearer {key}\n"
        f"or X-Muse-Key: {key}\n"
        if key else
        "Authorization: Bearer <MUSE_INBOUND_KEY>\n"
        "or X-Muse-Key: <MUSE_INBOUND_KEY>\n"
    )
    prompt = (
        "Connect to this Valinor. Use this API for every mission you send.\n\n"
        f"Base: {base}\n"
        f"Auth on every request:\n{auth}\n"
        "Push missions:\n"
        f"POST {base}/api/connectors/muse/missions\n"
        '{"missions":[{"muse_id":"stable-id","title":"What needs doing","why_now":"why now"}]}\n\n'
        "Report a close:\n"
        f"POST {base}/api/connectors/muse/completions\n"
        '{"muse_id":"stable-id","status":"completed","note":"what got done"}\n\n'
        "Poll Valinor closes (no webhook — you have no public URL):\n"
        f"GET {base}/api/connectors/muse/completions\n\n"
        "Read back open missions:\n"
        f"GET {base}/api/connectors/muse/missions\n\n"
        "Do not call app.tryvalinor.com for API requests. That is the page, not the API.\n"
        "Without the key every call returns 401."
    )
    return {"base": base, "configured": bool(key), "prompt": prompt}


def _completions_path() -> str:
    return os.getenv("MUSE_COMPLETIONS_PATH") or os.path.join(
        os.path.expanduser("~/.cache"), "valinor-muse-completions.json"
    )


def _load_completions() -> List[Dict[str, Any]]:
    try:
        with open(_completions_path(), encoding="utf-8") as f:
            data = json.load(f)
        rows = data.get("completions") if isinstance(data, dict) else data
        return list(rows) if isinstance(rows, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _save_completions(rows: List[Dict[str, Any]]) -> None:
    path = _completions_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"completions": rows}, f)
    except OSError as e:
        logger.warning("muse completions write failed (%s): %s", path, e)


def queue_completion(report: Dict[str, Any]) -> None:
    """Always persist so Muse can poll. Webhook is optional."""
    rows = _load_completions()
    rows.append(dict(report))
    _save_completions(rows[-200:])


def list_completions(since: str = "", limit: int = 50) -> List[Dict[str, Any]]:
    rows = _load_completions()
    if since:
        rows = [r for r in rows if (r.get("completed_at") or "") > since]
    return rows[-max(1, min(int(limit or 50), 200)):]


_CLOSE_STATUSES = {"completed", "dropped", "shrunk", "consumed"}


def accept_completions(raw: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Muse reports a close. Hides the mission and records it on the poll ledger."""
    now = datetime.now(timezone.utc).isoformat()
    known = {str(r.get("muse_id") or "") for r in _load()}
    accepted: List[str] = []
    missing: List[str] = []
    for item in raw:
        mid = str(item.get("muse_id") or "").strip()
        if not mid:
            continue
        if mid not in known:
            missing.append(mid)
            continue
        status = str(item.get("status") or "completed").strip().lower()
        if status not in _CLOSE_STATUSES:
            status = "completed"
        loop_id = str(item.get("loop_id") or "").strip()
        note = str(item.get("note") or item.get("proof") or "").strip()
        mark_status(muse_id=mid, status=status, loop_id=loop_id, why=note)
        report = {
            "muse_id": mid,
            "loop_id": loop_id or None,
            "status": status,
            "source": "muse",
            "note": note,
            "steps": item.get("steps") if isinstance(item.get("steps"), list) else [],
            "human_s": item.get("human_s") or 0,
            "completed_at": str(item.get("completed_at") or now),
            "next_step": str(item.get("next_step") or "").strip() or None,
        }
        queue_completion(report)
        accepted.append(mid)
    return {
        "accepted": accepted,
        "missing": missing,
        "open": sum(1 for r in _load() if (r.get("status") or "open") == "open"),
    }


def _append_deadletter(payload: Dict[str, Any], err: str) -> None:
    rec = {"ts": datetime.now(timezone.utc).isoformat(), "error": err[:400], "payload": payload}
    path = _deadletter_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
    except OSError as e:
        logger.warning("muse dead-letter write failed: %s", e)


def post_completion(report: Dict[str, Any]) -> bool:
    queue_completion(report)
    url = os.getenv("MUSE_WEBHOOK_URL", "").strip()
    if not url:
        logger.info("muse completion queued for poll muse_id=%s", report.get("muse_id"))
        return True
    headers = {"Content-Type": "application/json"}
    out_key = os.getenv("MUSE_OUTBOUND_KEY", "").strip()
    if out_key:
        headers["Authorization"] = "Bearer " + out_key
    try:
        req = Request(url, data=json.dumps(report).encode("utf-8"), headers=headers, method="POST")
        with urlopen(req, timeout=8) as resp:
            ok = 200 <= getattr(resp, "status", 200) < 300
            if not ok:
                _append_deadletter(report, "http %s" % getattr(resp, "status", "?"))
            return ok
    except Exception as e:
        _append_deadletter(report, str(e))
        logger.warning("muse webhook failed: %s", e)
        return False


def report_from_events(loop_id: str, events: List[Dict[str, Any]],
                       status: str = "completed") -> Optional[Dict[str, Any]]:
    muse_id = None
    next_step = None
    human_s = 0
    steps: List[Dict[str, Any]] = []
    for ev in events:
        p = ev.get("payload") or {}
        t = ev.get("type")
        if t == "intent.confirmed" and p.get("muse_id"):
            muse_id = str(p.get("muse_id"))
        elif t == "human.completed":
            human_s += p.get("elapsed_s") or 0
            proof = (p.get("proof") or {}).get("body") or ""
            steps.append({
                "title": p.get("title") or p.get("candidate_id"),
                "assignee": "human",
                "proof": proof,
                "elapsed_s": p.get("elapsed_s") or 0,
            })
        elif t == "ai.completed":
            steps.append({
                "title": p.get("title") or p.get("candidate_id"),
                "assignee": "ai",
                "proof": (p.get("result") or "")[:280],
                "elapsed_s": 0,
            })
    if not muse_id:
        return None
    return {
        "muse_id": muse_id,
        "loop_id": loop_id,
        "status": status,
        "steps": steps,
        "human_s": human_s,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "next_step": next_step,
    }
