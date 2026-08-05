"""
Guided Laundry loop — pause at each stage with encouragement,
adapt to what the user reports, persist progress as a laundry note.
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select

from database import Run, RunStep, async_session
from notes_store import createNote, tag, updateNote

from coach_llm import apply_start_coach_override, merge_coach

LAUNDRY_STATUSES = ["started", "washing", "dried", "folded", "put_away"]

STATUS_TO_STAGE = {
    "started": "DISCOVER",
    "washing": "PLAN",
    "dried": "EXECUTE",
    "folded": "VERIFY",
    "put_away": "DONE",
}

STAGE_ORDER = ["DISCOVER", "PLAN", "EXECUTE", "VERIFY", "DONE"]

COACH: Dict[str, Dict[str, Any]] = {
    "started": {
        "headline": "Gather the load",
        "encouragement": "Small start. You’re already doing the hard part — beginning.",
        "guidance": (
            "Look at the pile and decide what this load is. "
            "Lights, darks, towels, or a mixed quick load — pick one and collect it."
        ),
        "actions": [
            "Pull one clear pile (don’t sort the whole house)",
            "Check pockets",
            "Carry it to the washer",
        ],
        "question": "What load are you starting, and where is it now?",
        "cta": "I gathered it",
    },
    "washing": {
        "headline": "Get it washing",
        "encouragement": "Nice — the pile has a destination. Momentum counts.",
        "guidance": (
            "Load the washer, add detergent, pick a cycle, and start it. "
            "If it’s already running, just say so."
        ),
        "actions": [
            "Load without packing too tight",
            "Add detergent / pods",
            "Start the cycle",
        ],
        "question": "Is the washer running, or what blocked you?",
        "cta": "Washer’s going",
    },
    "dried": {
        "headline": "Move it to dry",
        "encouragement": "Wash done is a real win. Don’t leave it sitting wet.",
        "guidance": (
            "When the wash finishes, move clothes to the dryer (or hang-dry). "
            "Start the dryer or set them out to air dry."
        ),
        "actions": [
            "Move wash → dryer / line",
            "Clear the lint trap if using dryer",
            "Start dry or hang",
        ],
        "question": "Are they drying now — dryer or hang?",
        "cta": "Drying now",
    },
    "folded": {
        "headline": "Fold while it’s warm",
        "encouragement": "Almost home. Folding now saves future-you from the chair-pile.",
        "guidance": (
            "Pull dry clothes and fold (or hang) them. "
            "Imperfect folds still count — speed over perfection."
        ),
        "actions": [
            "Empty dryer / take down hang-dry",
            "Fold or hang each piece",
            "Make a small stack ready to put away",
        ],
        "question": "Folded yet, or still a warm heap?",
        "cta": "Folded",
    },
    "put_away": {
        "headline": "Put it away",
        "encouragement": "Last step. This is what makes the loop actually finish.",
        "guidance": (
            "Walk the folded stack to drawers / closet / shelves. "
            "When it’s away, this load is done."
        ),
        "actions": [
            "Carry the stack to its home",
            "Put each thing away",
            "Clear the laundry zone",
        ],
        "question": "Is everything put away?",
        "cta": "Put away — done",
    },
}


def _dumps(obj: Any) -> str:
    return json.dumps(obj, default=str)


def _loads(text: Optional[str], default: Any = None) -> Any:
    if not text:
        return default
    try:
        return json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return default


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _coach_for(
    status: str,
    *,
    last_message: Optional[str] = None,
    coach_overrides: Optional[Dict[str, Dict[str, str]]] = None,
) -> Dict[str, Any]:
    base = merge_coach(dict(COACH[status]), (coach_overrides or {}).get(status))
    stage = STATUS_TO_STAGE[status]
    return {
        "stage": stage,
        "stage_number": STAGE_ORDER.index(stage) + 1,
        "stage_total": len(STAGE_ORDER),
        "laundry_status": status,
        "headline": base["headline"],
        "guidance": base["guidance"],
        "question": base["question"],
        "cta": base["cta"],
        "last_message": last_message,
        "ring": LAUNDRY_STATUSES,
    }


def _infer_status_from_message(message: str, current: str) -> Tuple[str, str]:
    """
    Adapt to what the user said.
    Returns (next_status, mode) where mode is advance|stay|jump|complete.
    """
    text = (message or "").lower().strip()
    idx = LAUNDRY_STATUSES.index(current)

    stay_words = ("stuck", "help", "not yet", "haven't", "havent", "still", "wait", "can't", "cant")
    if any(w in text for w in stay_words) and not any(
        w in text for w in ("done", "finished", "put away", "folded", "dryer", "washing")
    ):
        return current, "stay"

    # Jump detection (later stages mentioned explicitly)
    if re.search(r"\bput[- ]?away\b|\bin (the )?closet\b|\bin (the )?drawer", text):
        return "put_away", "jump" if current != "put_away" else "complete"
    if re.search(r"\bfold(ed|ing)?\b", text) and current in ("started", "washing", "dried", "folded"):
        return "folded" if current != "folded" else "put_away", "jump" if current not in ("folded", "put_away") else "advance"
    if re.search(r"\bdry(er|ing|ed)?\b|\bhang(ing)?\b", text) and current in ("started", "washing", "dried"):
        return "dried" if current != "dried" else "folded", "jump" if current != "dried" else "advance"
    if re.search(r"\bwash(er|ing|ed)?\b|\bcycle\b|\brunning\b", text) and current in ("started", "washing"):
        return "washing" if current == "started" else "dried", "advance"

    done_words = ("done", "finished", "complete", "did it", "yes", "yep", "ok", "okay", "ready")
    if any(w in text for w in done_words) or len(text) > 0:
        # Default: advance one step on any substantive reply
        if current == "put_away":
            return "put_away", "complete"
        nxt = LAUNDRY_STATUSES[min(idx + 1, len(LAUNDRY_STATUSES) - 1)]
        return nxt, "advance" if nxt != current else "complete"

    return current, "stay"


async def _get_run(run_id: str) -> Optional[Run]:
    async with async_session() as session:
        result = await session.execute(select(Run).where(Run.id == run_id))
        return result.scalar_one_or_none()


async def _save_state(run_id: str, state: Dict[str, Any], status: str) -> None:
    async with async_session() as session:
        result = await session.execute(select(Run).where(Run.id == run_id))
        run = result.scalar_one()
        run.status = status
        run.plan = _dumps(state)
        run.committed = status == "DONE"
        run.updated_at = datetime.utcnow()
        await session.commit()


async def _append_step(
    run_id: str,
    stage: str,
    input_data: Any,
    output_data: Any,
) -> None:
    async with async_session() as session:
        session.add(
            RunStep(
                id=str(uuid.uuid4()),
                run_id=run_id,
                state=stage,
                input=_dumps(input_data) if input_data is not None else None,
                output=_dumps(output_data) if output_data is not None else None,
            )
        )
        await session.commit()


async def _steps_for(run_id: str) -> List[Dict[str, Any]]:
    async with async_session() as session:
        result = await session.execute(
            select(RunStep).where(RunStep.run_id == run_id).order_by(RunStep.created_at.asc())
        )
        steps = list(result.scalars().all())
        return [
            {
                "id": s.id,
                "state": s.state,
                "input": _loads(s.input),
                "output": _loads(s.output),
                "created_at": s.created_at.isoformat() if s.created_at else None,
            }
            for s in steps
        ]


def _run_payload(run: Run, state: Dict[str, Any], steps: List[Dict[str, Any]]) -> Dict[str, Any]:
    status = state.get("laundry_status") or "started"
    history = state.get("history") or []
    last_user = next(
        (h.get("message") for h in reversed(history) if h.get("mode") != "start"),
        None,
    )
    coach = _coach_for(status, last_message=last_user, coach_overrides=state.get("coach_overrides"))
    if run.status == "DONE":
        coach = {
            **coach,
            "headline": "Load complete",
            "guidance": "Finished: started → washing → dried → folded → put away.",
            "question": "",
            "cta": "Done",
            "last_message": last_user,
        }
    return {
        "id": run.id,
        "guided": True,
        "loop": "laundry",
        "intent": run.intent,
        "input_query": run.input_query,
        "status": run.status,
        "attempt": run.attempt,
        "max_attempts": run.max_attempts,
        "committed": run.committed,
        "laundry_status": status,
        "note_id": state.get("note_id"),
        "coach": coach,
        "history": history,
        "steps": steps,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "updated_at": run.updated_at.isoformat() if run.updated_at else None,
    }


async def start_laundry(prompt: str) -> Dict[str, Any]:
    prompt = (prompt or "").strip() or "Help me do one load of laundry."
    run_id = str(uuid.uuid4())
    title = f"Laundry — {datetime.utcnow().strftime('%b %d %H:%M')}"
    body = (
        f"Prompt: {prompt}\n"
        f"Status: started\n"
        f"Updated: {_now()}\n"
    )
    note = await createNote(
        title=title,
        body=body,
        tags=["laundry", "started"],
        compute_embedding=False,
    )

    state = {
        "guided": True,
        "loop": "laundry",
        "prompt": prompt,
        "laundry_status": "started",
        "note_id": note["id"],
        "history": [{"at": _now(), "status": "started", "message": prompt, "mode": "start"}],
    }
    state, _ = await apply_start_coach_override(
        loop_id="laundry",
        prompt=prompt,
        first_status="started",
        base_coach=dict(COACH["started"]),
        state=state,
    )
    coach = _coach_for("started", coach_overrides=state.get("coach_overrides"))

    async with async_session() as session:
        session.add(
            Run(
                id=run_id,
                intent="laundry",
                input_query=prompt,
                status="DISCOVER",
                attempt=1,
                max_attempts=1,
                committed=False,
                plan=_dumps(state),
            )
        )
        await session.commit()

    await _append_step(
        run_id,
        "DISCOVER",
        {"prompt": prompt},
        {
            "guided": True,
            "headline": coach["headline"],
            "guidance": coach["guidance"],
            "laundry_status": "started",
            "note_id": note["id"],
        },
    )

    run = await _get_run(run_id)
    steps = await _steps_for(run_id)
    return _run_payload(run, state, steps)


async def get_laundry(run_id: str) -> Optional[Dict[str, Any]]:
    run = await _get_run(run_id)
    if not run:
        return None
    state = _loads(run.plan, {}) or {}
    if not state.get("guided"):
        return None
    steps = await _steps_for(run_id)
    return _run_payload(run, state, steps)


async def respond_laundry(run_id: str, message: str) -> Dict[str, Any]:
    message = (message or "").strip()
    if not message:
        raise ValueError("Message required")

    run = await _get_run(run_id)
    if not run:
        raise KeyError("Run not found")
    state = _loads(run.plan, {}) or {}
    if not state.get("guided"):
        raise ValueError("Not a guided laundry run")

    current = state.get("laundry_status") or "started"
    if run.status == "DONE" or current == "put_away" and run.committed:
        steps = await _steps_for(run_id)
        return _run_payload(run, state, steps)

    nxt, mode = _infer_status_from_message(message, current)
    note_id = state.get("note_id")

    # Persist update on the laundry note
    if note_id:
        stamp = _now()
        line = f"[{stamp}] ({current} → {nxt} via {mode}) {message}\n"
        # Read-ish update by appending via updateNote body rebuild from history
        history_lines = "\n".join(
            f"- {h.get('at')}: {h.get('status')} — {h.get('message')}"
            for h in (state.get("history") or [])
        )
        body = (
            f"Prompt: {state.get('prompt')}\n"
            f"Status: {nxt}\n"
            f"Updated: {stamp}\n\n"
            f"Latest: {message}\n\n"
            f"Log:\n{history_lines}\n- {stamp}: {nxt} — {message}\n"
        )
        await updateNote(
            note_id,
            body=body,
            tags=["laundry", nxt],
            compute_embedding=False,
        )
        # Ensure status tag present
        await tag(note_id, ["laundry", nxt])

    state["laundry_status"] = nxt
    state.setdefault("history", []).append(
        {"at": _now(), "status": nxt, "message": message, "mode": mode, "from": current}
    )

    stage = STATUS_TO_STAGE[nxt]
    coach = _coach_for(nxt, last_message=message)

    if mode == "stay":
        coach["guidance"] = (
            "Still on this step — say what’s blocking you (no detergent, dryer full, no time) "
            "and we’ll adjust."
        )
    elif mode == "jump":
        coach["guidance"] = "Meeting you where you are. " + coach["guidance"]
    elif mode == "complete" or nxt == "put_away":
        stage = "DONE"

    await _save_state(run_id, state, stage)
    await _append_step(
        run_id,
        stage,
        {"message": message, "from": current, "mode": mode},
        {
            "guided": True,
            "headline": coach["headline"],
            "guidance": coach["guidance"],
            "laundry_status": nxt,
            "adapted": mode,
            "last_message": message,
        },
    )

    run = await _get_run(run_id)
    steps = await _steps_for(run_id)
    return _run_payload(run, state, steps)
