"""
UI event ingest + design metrics for the Loops hill-climb rig.
"""
from __future__ import annotations

import json
import statistics
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Union

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import UiEvent, get_session

router = APIRouter(tags=["events"])

EVENT_KINDS = {
    "loop_started",
    "step_advanced",
    "step_abandoned",
    "step_shown",
    "loop_completed",
    "loop_reset",
}


class UiEventIn(BaseModel):
    kind: str
    run_id: Optional[str] = None
    loop_kind: Optional[str] = None
    stage_number: Optional[int] = None
    ts: Optional[Union[int, float, str]] = None
    meta: Optional[Dict[str, Any]] = None
    time_on_step: Optional[int] = None


class EventsBatch(BaseModel):
    events: List[UiEventIn] = Field(default_factory=list)


def _parse_ts(raw: Optional[Union[int, float, str]]) -> datetime:
    if raw is None:
        return datetime.utcnow()
    if isinstance(raw, (int, float)):
        v = float(raw)
        if v > 1e10:
            v = v / 1000.0
        return datetime.utcfromtimestamp(v)
    s = str(raw).strip()
    if not s:
        return datetime.utcnow()
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s).replace(tzinfo=None)
    except ValueError:
        return datetime.utcnow()


def _median(values: List[float]) -> Optional[float]:
    if not values:
        return None
    return float(statistics.median(values))


def _meta(row: UiEvent) -> Dict[str, Any]:
    if not row.meta_json:
        return {}
    try:
        return json.loads(row.meta_json) or {}
    except json.JSONDecodeError:
        return {}


@router.post("/events")
async def ingest_events(
    body: Union[EventsBatch, List[UiEventIn]],
    session: AsyncSession = Depends(get_session),
):
    """Accept a batch (or bare array) of UI events. Always 200; never block the UI."""
    items = body if isinstance(body, list) else (body.events or [])

    accepted = 0
    for item in items:
        kind = (item.kind or "").strip()
        if kind not in EVENT_KINDS:
            continue
        meta = dict(item.meta or {})
        if item.time_on_step is not None and "time_on_step" not in meta:
            meta["time_on_step"] = item.time_on_step
        session.add(
            UiEvent(
                id=str(uuid.uuid4()),
                run_id=item.run_id,
                kind=kind,
                loop_kind=item.loop_kind,
                stage_number=item.stage_number,
                meta_json=json.dumps(meta) if meta else None,
                ts=_parse_ts(item.ts),
            )
        )
        accepted += 1

    if accepted:
        await session.commit()
    return {"ok": True, "accepted": accepted}


@router.get("/metrics/loops")
async def loops_metrics(session: AsyncSession = Depends(get_session)):
    """Read-only aggregates from UiEvent. Thin data → nulls, not fake significance."""
    result = await session.execute(select(UiEvent).order_by(UiEvent.ts.asc()))
    rows = list(result.scalars().all())

    started = 0
    completed = 0
    taps_to_advance: List[float] = []
    time_to_first: List[float] = []
    shown_by_stage: Dict[int, int] = {}
    abandoned_by_stage: Dict[int, int] = {}

    run_started_ts: Dict[str, datetime] = {}
    run_got_first: Dict[str, bool] = {}

    for row in rows:
        rid = row.run_id or ""
        stage = row.stage_number
        meta = _meta(row)

        if row.kind == "loop_started":
            started += 1
            if rid:
                run_started_ts[rid] = row.ts
                run_got_first[rid] = False

        elif row.kind == "step_shown":
            if stage is not None:
                shown_by_stage[stage] = shown_by_stage.get(stage, 0) + 1
            tfa = meta.get("time_to_first_action_ms")
            if tfa is not None and rid and not run_got_first.get(rid):
                try:
                    time_to_first.append(float(tfa))
                    run_got_first[rid] = True
                except (TypeError, ValueError):
                    pass

        elif row.kind == "step_advanced":
            taps = meta.get("taps", 1)
            try:
                taps_to_advance.append(float(taps))
            except (TypeError, ValueError):
                pass
            if rid and not run_got_first.get(rid) and rid in run_started_ts:
                delta_ms = (row.ts - run_started_ts[rid]).total_seconds() * 1000.0
                if delta_ms >= 0:
                    time_to_first.append(delta_ms)
                run_got_first[rid] = True

        elif row.kind == "step_abandoned":
            if stage is not None:
                abandoned_by_stage[stage] = abandoned_by_stage.get(stage, 0) + 1

        elif row.kind == "loop_completed":
            completed += 1

    abandon_rate_by_stage: Dict[str, Optional[float]] = {}
    for s in sorted(set(shown_by_stage) | set(abandoned_by_stage)):
        shown = shown_by_stage.get(s, 0)
        abandoned = abandoned_by_stage.get(s, 0)
        if shown > 0:
            abandon_rate_by_stage[str(s)] = round(abandoned / shown, 4)
        elif abandoned > 0:
            abandon_rate_by_stage[str(s)] = 1.0
        else:
            abandon_rate_by_stage[str(s)] = None

    return {
        "n_events": len(rows),
        "n_started": started,
        "n_completed": completed,
        "completion_rate": round(completed / started, 4) if started > 0 else None,
        "median_taps_to_advance": _median(taps_to_advance),
        "median_time_to_first_action": _median(time_to_first),
        "abandon_rate_by_stage": abandon_rate_by_stage,
        "thin_data": started < 10,
        "note": (
            "Single-user / thin sample — treat as directional, not significant."
            if started < 10
            else None
        ),
    }
