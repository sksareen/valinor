"""Muse connector HTTP surface.

  POST /api/connectors/muse/missions      inbound framed missions
  GET  /api/connectors/muse/missions      open missions (Muse read-back)
  GET  /api/connectors/muse/completions   Valinor closes, for Muse to poll
  POST /api/connectors/muse/completions   Muse reports a close
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from muse import (
    accept_completions,
    inbound_authorized,
    list_completions,
    surfaced_missions,
    upsert_missions,
)

router = APIRouter(tags=["muse"])


class MuseMissionIn(BaseModel):
    muse_id: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=70)
    outcome: str = ""
    theme: str = ""
    comment: str = ""
    why_now: str = ""
    priority: Optional[int] = None


class MuseBatchIn(BaseModel):
    missions: List[MuseMissionIn] = Field(min_length=1, max_length=50)


class MuseCompletionIn(BaseModel):
    muse_id: str = Field(min_length=1)
    status: str = "completed"
    loop_id: str = ""
    note: str = ""
    proof: str = ""
    completed_at: str = ""
    next_step: str = ""
    human_s: Optional[int] = None
    steps: Optional[List[Dict[str, Any]]] = None


class MuseCompletionBody(BaseModel):
    muse_id: Optional[str] = None
    status: str = "completed"
    loop_id: str = ""
    note: str = ""
    proof: str = ""
    completed_at: str = ""
    next_step: str = ""
    human_s: Optional[int] = None
    steps: Optional[List[Dict[str, Any]]] = None
    completions: Optional[List[MuseCompletionIn]] = None


def _require_muse(authorization: str, x_muse_key: str) -> None:
    if not inbound_authorized(authorization or "", x_muse_key or ""):
        raise HTTPException(status_code=401, detail="missing or wrong Muse key")


@router.post("/api/connectors/muse/missions")
async def muse_push(
    body: MuseBatchIn,
    authorization: str = Header(default=""),
    x_muse_key: str = Header(default="", alias="X-Muse-Key"),
):
    _require_muse(authorization, x_muse_key)
    stats = upsert_missions([m.model_dump() for m in body.missions])
    return {"ok": True, **stats}


@router.get("/api/connectors/muse/missions")
async def muse_list(
    authorization: str = Header(default=""),
    x_muse_key: str = Header(default="", alias="X-Muse-Key"),
) -> Dict[str, Any]:
    _require_muse(authorization, x_muse_key)
    return {"missions": surfaced_missions()}


@router.get("/api/connectors/muse/completions")
async def muse_completions(
    since: str = "",
    limit: int = 50,
    authorization: str = Header(default=""),
    x_muse_key: str = Header(default="", alias="X-Muse-Key"),
) -> Dict[str, Any]:
    """Muse polls this. No webhook required — Muse has no public URL."""
    _require_muse(authorization, x_muse_key)
    return {"completions": list_completions(since=since, limit=limit)}


@router.post("/api/connectors/muse/completions")
async def muse_report_close(
    body: MuseCompletionBody,
    authorization: str = Header(default=""),
    x_muse_key: str = Header(default="", alias="X-Muse-Key"),
):
    """Muse reports a mission closed. Same auth as POST /missions."""
    _require_muse(authorization, x_muse_key)
    if body.completions:
        raw = [c.model_dump() for c in body.completions]
    elif body.muse_id:
        raw = [body.model_dump(exclude={"completions"})]
    else:
        raise HTTPException(status_code=400, detail="muse_id or completions[] required")
    stats = accept_completions(raw)
    if not stats["accepted"] and stats["missing"]:
        raise HTTPException(status_code=404, detail={"missing": stats["missing"]})
    return {"ok": True, **stats}
