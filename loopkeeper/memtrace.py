"""
Append-only memory for Valinor loop deck runs.

Every card in the deck writes typed events here; review reads the full
timeline back. INSERT + SELECT only — no update or delete paths exist.

Types map 1:1 to future KO types:
  cluster.selected, intent.confirmed, plan.drafted, jev.verdicts,
  user.selection, ai.completed, human.completed, outcome.recorded
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import MemEvent

MEM_TYPES = frozenset({
    "cluster.selected",
    "intent.confirmed",
    "intent.classified",
    "note.captured",
    "plan.drafted",
    "jev.verdicts",
    "user.selection",
    "ai.completed",
    "human.completed",
    "outcome.recorded",
    "win.celebrated",
})

ACTORS = frozenset({"user", "planner", "jev", "ai", "system"})


def _payload(row: MemEvent) -> Dict[str, Any]:
    if not row.payload_json:
        return {}
    try:
        return json.loads(row.payload_json) or {}
    except json.JSONDecodeError:
        return {}


def serialize(row: MemEvent) -> Dict[str, Any]:
    ts = row.ts.isoformat() if isinstance(row.ts, datetime) else row.ts
    return {
        "id": row.id,
        "loop_id": row.loop_id,
        "type": row.type,
        "actor": row.actor,
        "payload": _payload(row),
        "ts": ts,
    }


async def write(
    session: AsyncSession,
    loop_id: str,
    type: str,
    actor: str,
    payload: Optional[Dict[str, Any]] = None,
) -> MemEvent:
    """Append one memory event. Raises ValueError on bad type/actor."""
    if type not in MEM_TYPES:
        raise ValueError(f"unknown mem type: {type!r} (expected one of {sorted(MEM_TYPES)})")
    if actor not in ACTORS:
        raise ValueError(f"unknown actor: {actor!r} (expected one of {sorted(ACTORS)})")
    row = MemEvent(
        id=str(uuid.uuid4()),
        loop_id=loop_id,
        type=type,
        actor=actor,
        payload_json=json.dumps(payload or {}),
        ts=datetime.utcnow(),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def read_loop(session: AsyncSession, loop_id: str) -> List[MemEvent]:
    """All events for one loop, oldest first."""
    result = await session.execute(
        select(MemEvent)
        .where(MemEvent.loop_id == loop_id)
        .order_by(MemEvent.ts.asc(), MemEvent.id.asc())
    )
    return list(result.scalars().all())


async def latest(
    session: AsyncSession, loop_id: str, type: str
) -> Optional[MemEvent]:
    """Most recent event of a given type in a loop, or None."""
    result = await session.execute(
        select(MemEvent)
        .where(MemEvent.loop_id == loop_id, MemEvent.type == type)
        .order_by(MemEvent.ts.desc(), MemEvent.id.desc())
        .limit(1)
    )
    return result.scalars().first()
