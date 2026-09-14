"""
HTTP routes for the agentic run-loop.
"""
import json
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field

from run_loop import get_run, start_run

router = APIRouter(tags=["runs"])


class StartRunRequest(BaseModel):
    query: str = Field(..., min_length=1, description="User intent / request over notes")
    max_attempts: int = Field(default=3, ge=1, le=10)
    async_mode: bool = Field(
        default=False,
        description="If true, return immediately after creating the run and process in background",
    )


class GuidedLaundryStartRequest(BaseModel):
    prompt: str = Field(
        default="Help me do my laundry",
        min_length=1,
        description="A basic prompt that starts the guided Laundry loop",
    )


class GuidedLaundryResponseRequest(BaseModel):
    message: str = Field(
        ...,
        min_length=1,
        description="What the person observed, changed, completed, or needs help with",
    )


@router.post("/guided-runs/laundry")
async def create_guided_laundry(body: GuidedLaundryStartRequest):
    """Start a persisted Laundry loop that pauses for input at every stage."""
    from guided_laundry import start_laundry

    try:
        return await start_laundry(body.prompt)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/guided-runs/laundry/{run_id}")
async def read_guided_laundry(run_id: str):
    from guided_laundry import get_laundry

    try:
        return await get_laundry(run_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.post("/guided-runs/laundry/{run_id}/respond")
async def respond_to_guided_laundry(
    run_id: str,
    body: GuidedLaundryResponseRequest,
):
    """Advance at most one stage, adapting the guidance to the person's update."""
    from guided_laundry import respond_laundry

    try:
        return await respond_laundry(run_id, body.message)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/runs")
async def create_run(body: StartRunRequest, background_tasks: BackgroundTasks):
    """
    Start a run. By default drives the full state machine synchronously and
    returns the live/final state. Set async_mode=true to enqueue and poll via GET.
    """
    if body.async_mode:
        import uuid
        from datetime import datetime

        from database import Run, async_session

        run_id = str(uuid.uuid4())
        async with async_session() as session:
            session.add(
                Run(
                    id=run_id,
                    input_query=body.query,
                    status="DISCOVER",
                    attempt=0,
                    max_attempts=body.max_attempts,
                    committed=False,
                    created_at=datetime.utcnow(),
                    updated_at=datetime.utcnow(),
                )
            )
            await session.commit()

        background_tasks.add_task(
            _run_async_safe, body.query, body.max_attempts, run_id
        )
        return {
            "id": run_id,
            "status": "DISCOVER",
            "input_query": body.query,
            "attempt": 0,
            "max_attempts": body.max_attempts,
            "committed": False,
            "message": "Run started in background; poll GET /runs/{id}",
        }

    try:
        result = await start_run(body.query, max_attempts=body.max_attempts)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


async def _run_async_safe(query: str, max_attempts: int, run_id: str) -> None:
    try:
        # start_run always inserts; for pre-created shell rows, resume via internal path
        from datetime import datetime
        import json

        from database import Run, async_session
        from sqlalchemy import select

        async with async_session() as session:
            result = await session.execute(select(Run).where(Run.id == run_id))
            existing = result.scalar_one_or_none()
            if existing:
                # Delete shell so start_run can recreate with same id cleanly
                await session.delete(existing)
                await session.commit()

        await start_run(query, max_attempts=max_attempts, run_id=run_id)
    except Exception as e:
        from datetime import datetime
        import json
        import uuid as _uuid

        from database import Run, RunStep, async_session
        from sqlalchemy import select

        async with async_session() as session:
            result = await session.execute(select(Run).where(Run.id == run_id))
            run = result.scalar_one_or_none()
            if run:
                run.status = "FAILED"
                run.failure_reasons = json.dumps([str(e)])
                run.updated_at = datetime.utcnow()
                session.add(
                    RunStep(
                        id=str(_uuid.uuid4()),
                        run_id=run_id,
                        state="FAILED",
                        input=None,
                        output=json.dumps({"error": str(e)}),
                    )
                )
                await session.commit()
            else:
                session.add(
                    Run(
                        id=run_id,
                        input_query=query,
                        status="FAILED",
                        attempt=0,
                        max_attempts=max_attempts,
                        committed=False,
                        failure_reasons=json.dumps([str(e)]),
                    )
                )
                await session.commit()


@router.get("/runs")
async def list_runs(
    status: Optional[str] = None,
    committed: Optional[bool] = None,
    limit: int = 40,
    include_archived: bool = False,
):
    """List recent runs (newest first). Use status=DONE or committed=true for the completed log."""
    from sqlalchemy import select

    from database import Run, async_session

    limit = max(1, min(int(limit or 40), 100))
    # Over-fetch when filtering archived in Python
    fetch_n = limit * 4 if not include_archived else limit
    async with async_session() as session:
        q = select(Run).order_by(Run.updated_at.desc())
        if status and status.upper() == "DONE":
            from sqlalchemy import or_

            q = q.where(or_(Run.status == "DONE", Run.committed.is_(True)))
        elif status:
            q = q.where(Run.status == status.upper())
        if committed is True:
            from sqlalchemy import or_

            q = q.where(or_(Run.committed.is_(True), Run.status == "DONE"))
        elif committed is False:
            q = q.where(Run.committed.is_(False)).where(Run.status != "DONE")
        q = q.limit(fetch_n)
        result = await session.execute(q)
        rows = list(result.scalars().all())

    items = []
    for run in rows:
        plan = {}
        if run.plan:
            try:
                plan = json.loads(run.plan) or {}
            except (TypeError, json.JSONDecodeError):
                plan = {}
        if not include_archived and plan.get("archived"):
            continue
        loop = _infer_loop_kind(plan, run.intent, run.input_query)
        loop_status = (
            plan.get("loop_status")
            or plan.get(f"{loop}_status")
            or plan.get("laundry_status")
            or plan.get("gym_status")
            or plan.get("japa_status")
            or run.status
        )
        guided = bool(plan.get("guided")) or bool(plan.get("loop")) or (
            bool(run.intent) and run.intent not in ("notes",)
        )
        if loop == "notes" and not plan.get("guided"):
            guided = False
        query = (run.input_query or "").strip().replace("\n", " ")
        items.append(
            {
                "id": run.id,
                "loop": loop,
                "guided": guided,
                "status": run.status,
                "committed": bool(run.committed),
                "archived": bool(plan.get("archived")),
                "loop_status": loop_status,
                "label": query[:72] + ("…" if len(query) > 72 else ""),
                "input_query": run.input_query,
                "created_at": run.created_at.isoformat() if run.created_at else None,
                "updated_at": run.updated_at.isoformat() if run.updated_at else None,
            }
        )
        if len(items) >= limit:
            break
    return {"runs": items, "n": len(items)}


@router.post("/runs/archive-completed")
async def archive_completed_runs():
    """Hide all completed runs from the completed log (soft archive via plan.archived)."""
    from datetime import datetime

    from sqlalchemy import or_, select

    from database import Run, async_session

    async with async_session() as session:
        result = await session.execute(
            select(Run).where(or_(Run.status == "DONE", Run.committed.is_(True)))
        )
        rows = list(result.scalars().all())
        n = 0
        for run in rows:
            plan = {}
            if run.plan:
                try:
                    plan = json.loads(run.plan) or {}
                except (TypeError, json.JSONDecodeError):
                    plan = {}
            if plan.get("archived"):
                continue
            plan["archived"] = True
            plan["archived_at"] = datetime.utcnow().isoformat() + "Z"
            run.plan = json.dumps(plan, default=str)
            run.updated_at = datetime.utcnow()
            n += 1
        await session.commit()
    return {"ok": True, "archived": n}


def _infer_loop_kind(plan: dict, intent: Optional[str], query: Optional[str]) -> str:
    q = (query or "").lower()
    probes = (
        ("japa", ("japa", "meditation", "mala", "mantra")),
        ("gym", ("gym", "workout", "exercise", "effective_load")),
        ("sleep", ("sleep", "slept", "hours slept", "bedtime")),
        ("walk", ("walk", "walking", "going on a walk", "stroll")),
        ("autoresearch", ("autoresearch", "hill-climb", "hill climb", "keep/discard")),
        ("laundry", ("laundry", "washer", "folded", "put away", "one load")),
    )
    for kind, needles in probes:
        if any(n in q for n in needles):
            return kind
    loop = plan.get("loop")
    if isinstance(loop, str) and loop.strip():
        return loop.strip()
    if intent and intent not in ("notes",):
        return intent
    if plan.get("guided"):
        return "loop"
    return "notes"


@router.get("/runs/{run_id}")
async def read_run(run_id: str):
    run = await get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run
