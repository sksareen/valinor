"""
Jev judge HTTP surface.

  POST /api/jev/judge   judge a batch of candidates, one verdict each

Pure function over HTTP: no memory writes, no side effects. The deck UI
persists verdicts via /api/mem/write as type jev.verdicts.
"""
from __future__ import annotations

import asyncio
import logging
from typing import List, Optional

logger = logging.getLogger(__name__)

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from jev_client import JEV_MODEL, Candidate, fallback_judge, judge

router = APIRouter(tags=["jev"])


class CandidateIn(BaseModel):
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    how: str = ""


class JudgeIn(BaseModel):
    candidates: List[CandidateIn] = Field(min_length=1)
    context: str = ""
    model: Optional[str] = None


@router.post("/api/jev/judge")
async def jev_judge(body: JudgeIn):
    cands = [Candidate(id=c.id, title=c.title, how=c.how) for c in body.candidates]
    try:
        batch, latency_ms = await asyncio.to_thread(
            judge, cands, body.context, body.model
        )
        fallback = False
        err = None
    except ValueError as e:
        raise HTTPException(status_code=502, detail=f"judge failed: {e}")
    except Exception as e:  # OpenRouter outage/auth — deterministic typed fallback
        logger.warning("jev fallback: %s", e)
        batch = fallback_judge(cands, body.context)
        latency_ms = 0
        fallback = True
        err = "auth" if "401" in str(e) else "error"
    return {
        "verdicts": [v.model_dump() for v in batch.verdicts],
        "latency_ms": latency_ms,
        "model": body.model or JEV_MODEL,
        "fallback": fallback,
        "error": err,
    }
