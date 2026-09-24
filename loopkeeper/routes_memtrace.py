"""
Memtrace HTTP surface: append-only loop memory.

  POST /api/mem/write       append one event
  GET  /api/mem/loop/{id}   ordered timeline for one loop

No update or delete routes exist by design.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from memtrace import MEM_TYPES, read_loop, serialize, write

router = APIRouter(tags=["memtrace"])


class MemWriteIn(BaseModel):
    loop_id: str = Field(min_length=1)
    type: str
    actor: str = "user"
    payload: Optional[Dict[str, Any]] = None


@router.post("/api/mem/write")
async def mem_write(body: MemWriteIn, session: AsyncSession = Depends(get_session)):
    try:
        row = await write(session, body.loop_id, body.type, body.actor, body.payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if body.type == "outcome.recorded":
        await _notify_muse_close(session, body.loop_id)
    return {"id": row.id, "ts": row.ts.isoformat()}


async def _notify_muse_close(session: AsyncSession, loop_id: str) -> None:
    """Fire-and-forget completion report. Never raises into the write path."""
    try:
        from muse import mark_status, post_completion, report_from_events
        from memtrace import read_loop, serialize
        rows = await read_loop(session, loop_id)
        events = [serialize(r) for r in rows]
        report = report_from_events(loop_id, events, status="completed")
        if not report:
            return
        mark_status(muse_id=report["muse_id"], status="completed", loop_id=loop_id)
        post_completion(report)
    except Exception:
        return


@router.get("/api/mem/loop/{loop_id}")
async def mem_loop(loop_id: str, session: AsyncSession = Depends(get_session)):
    rows = await read_loop(session, loop_id)
    return {"loop_id": loop_id, "events": [serialize(r) for r in rows]}


@router.get("/api/mem/types")
async def mem_types():
    """Allowed event types (for clients + debugging)."""
    return {"types": sorted(MEM_TYPES)}
