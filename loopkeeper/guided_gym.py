"""
Guided Gym loop — decide → leave → arrive → work → log.
Step-by-step coach with persistence as an exercise note.
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

GYM_STATUSES = ["decide", "leave", "arrive", "work", "log"]

STATUS_TO_STAGE = {
    "decide": "DISCOVER",
    "leave": "PLAN",
    "arrive": "EXECUTE",
    "work": "VERIFY",
    "log": "DONE",
}

STAGE_ORDER = ["DISCOVER", "PLAN", "EXECUTE", "VERIFY", "DONE"]

COACH: Dict[str, Dict[str, Any]] = {
    "decide": {
        "headline": "Decide the session",
        "guidance": (
            "You’ve got a little window before you leave. "
            "Pick gym or home, and one simple focus (push, pull, legs, conditioning, or a short full-body)."
        ),
        "question": "Gym or home — and what’s the focus? (You can leave in ~20 min.)",
        "cta": "I’ve decided",
    },
    "leave": {
        "headline": "Leave on time",
        "guidance": "Bag, shoes, water, headphones. Walk out — don’t renegotiate.",
        "question": "Are you out the door / on the way?",
        "cta": "I’m leaving",
    },
    "arrive": {
        "headline": "Arrive & set up",
        "guidance": "Get to the floor or rack. One warm-up set, then start the first real movement.",
        "question": "Are you there and ready to start?",
        "cta": "Ready",
    },
    "work": {
        "headline": "Do the work",
        "guidance": "Run the plan. Imperfect reps still count. Note roughly how long and how hard it felt.",
        "question": "Finished the main work? How many minutes, and intensity (low / moderate / high)?",
        "cta": "Session done",
    },
    "log": {
        "headline": "Log it",
        "guidance": "Capture minutes × intensity so the loop actually closes.",
        "question": "Anything to add before we close?",
        "cta": "Close loop",
    },
}

INTENSITY_FACTOR = {"low": 0.75, "moderate": 1.0, "high": 1.5, "1": 0.75, "2": 1.0, "3": 1.5}


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
        "gym_status": status,
        "loop_status": status,
        "headline": base["headline"],
        "guidance": base["guidance"],
        "question": base["question"],
        "cta": base["cta"],
        "last_message": last_message,
        "ring": GYM_STATUSES,
    }


def _parse_minutes_intensity(message: str) -> Tuple[Optional[int], Optional[str], Optional[float]]:
    text = message.lower()
    minutes = None
    m = re.search(r"(\d+)\s*(min|mins|minutes|m)\b", text)
    if m:
        minutes = int(m.group(1))
    else:
        m2 = re.search(r"\b(\d{1,3})\b", text)
        if m2 and 5 <= int(m2.group(1)) <= 180:
            minutes = int(m2.group(1))

    intensity = None
    for key in ("high", "moderate", "low"):
        if key in text:
            intensity = key
            break
    if intensity is None:
        if re.search(r"\b3\b", text):
            intensity = "high"
        elif re.search(r"\b2\b", text):
            intensity = "moderate"
        elif re.search(r"\b1\b", text):
            intensity = "low"

    load = None
    if minutes is not None and intensity:
        load = round(minutes * INTENSITY_FACTOR[intensity], 2)
    return minutes, intensity, load


def _infer_status(message: str, current: str) -> Tuple[str, str]:
    text = (message or "").lower().strip()
    idx = GYM_STATUSES.index(current)

    if any(w in text for w in ("stuck", "not yet", "still", "wait", "can't", "cant")):
        return current, "stay"

    if re.search(r"\b(done|finished|logged|complete)\b", text) and current in ("work", "log"):
        return "log", "complete" if current == "log" else "advance"

    if re.search(r"\b(working out|mid[- ]?set|lifting|running|on the floor)\b", text):
        return "work", "jump" if current != "work" else "advance"

    if re.search(r"\b(here|arrived|at the gym|on the mat)\b", text):
        return "arrive", "jump" if current not in ("arrive", "work", "log") else "advance"

    if re.search(r"\b(left|leaving|on my way|uber|driving|headed)\b", text):
        return "leave", "jump" if current == "decide" else "advance"

    if current == "log" or (current == "work" and re.search(r"\b(min|intensity|low|moderate|high)\b", text)):
        nxt = "log" if current == "work" else "log"
        return nxt, "advance" if current == "work" else "complete"

    if len(text) > 0:
        if current == "log":
            return "log", "complete"
        nxt = GYM_STATUSES[min(idx + 1, len(GYM_STATUSES) - 1)]
        return nxt, "advance"

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


async def _append_step(run_id: str, stage: str, input_data: Any, output_data: Any) -> None:
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
    status = state.get("gym_status") or "decide"
    history = state.get("history") or []
    last_user = next(
        (h.get("message") for h in reversed(history) if h.get("mode") != "start"),
        None,
    )
    coach = _coach_for(status, last_message=last_user, coach_overrides=state.get("coach_overrides"))
    if run.status == "DONE":
        mins = state.get("minutes")
        intensity = state.get("intensity")
        load = state.get("effective_load")
        bits = []
        if mins is not None:
            bits.append(f"{mins} min")
        if intensity:
            bits.append(intensity)
        if load is not None:
            bits.append(f"load {load}")
        coach = {
            **coach,
            "headline": "Session logged",
            "guidance": (" · ".join(bits) if bits else "Gym loop closed.")
            + " Nice work getting it done.",
            "question": "",
            "cta": "Done",
            "last_message": last_user,
        }
    return {
        "id": run.id,
        "guided": True,
        "loop": "gym",
        "intent": run.intent,
        "input_query": run.input_query,
        "status": run.status,
        "attempt": run.attempt,
        "max_attempts": run.max_attempts,
        "committed": run.committed,
        "gym_status": status,
        "loop_status": status,
        "note_id": state.get("note_id"),
        "minutes": state.get("minutes"),
        "intensity": state.get("intensity"),
        "effective_load": state.get("effective_load"),
        "coach": coach,
        "history": history,
        "steps": steps,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "updated_at": run.updated_at.isoformat() if run.updated_at else None,
    }


async def start_gym(prompt: str) -> Dict[str, Any]:
    prompt = (prompt or "").strip() or (
        "Gym loop — I need to decide what to do and I can leave in about 20 minutes."
    )
    run_id = str(uuid.uuid4())
    title = f"Gym — {datetime.utcnow().strftime('%b %d %H:%M')}"
    body = f"Prompt: {prompt}\nStatus: decide\nUpdated: {_now()}\n"
    note = await createNote(
        title=title,
        body=body,
        tags=["exercise", "gym", "decide"],
        compute_embedding=False,
    )
    state = {
        "guided": True,
        "loop": "gym",
        "prompt": prompt,
        "gym_status": "decide",
        "note_id": note["id"],
        "history": [{"at": _now(), "status": "decide", "message": prompt, "mode": "start"}],
    }
    state, _ = await apply_start_coach_override(
        loop_id="gym",
        prompt=prompt,
        first_status="decide",
        base_coach=dict(COACH["decide"]),
        state=state,
    )
    coach = _coach_for("decide", coach_overrides=state.get("coach_overrides"))

    async with async_session() as session:
        session.add(
            Run(
                id=run_id,
                intent="gym",
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
            "gym_status": "decide",
            "note_id": note["id"],
        },
    )
    run = await _get_run(run_id)
    steps = await _steps_for(run_id)
    payload = _run_payload(run, state, steps)
    payload["coach"] = coach
    return payload


async def get_gym(run_id: str) -> Optional[Dict[str, Any]]:
    run = await _get_run(run_id)
    if not run:
        return None
    state = _loads(run.plan, {}) or {}
    if state.get("loop") != "gym":
        return None
    steps = await _steps_for(run_id)
    return _run_payload(run, state, steps)


async def respond_gym(run_id: str, message: str) -> Dict[str, Any]:
    message = (message or "").strip()
    if not message:
        raise ValueError("Message required")

    run = await _get_run(run_id)
    if not run:
        raise KeyError("Run not found")
    state = _loads(run.plan, {}) or {}
    if state.get("loop") != "gym":
        raise ValueError("Not a guided gym run")

    current = state.get("gym_status") or "decide"
    if run.status == "DONE":
        steps = await _steps_for(run_id)
        return _run_payload(run, state, steps)

    nxt, mode = _infer_status(message, current)
    mins, intensity, load = _parse_minutes_intensity(message)
    if mins is not None:
        state["minutes"] = mins
    if intensity:
        state["intensity"] = intensity
    if load is not None:
        state["effective_load"] = load

    note_id = state.get("note_id")
    if note_id:
        stamp = _now()
        history_lines = "\n".join(
            f"- {h.get('at')}: {h.get('status')} — {h.get('message')}"
            for h in (state.get("history") or [])
        )
        extras = []
        if state.get("minutes") is not None:
            extras.append(f"Minutes: {state['minutes']}")
        if state.get("intensity"):
            extras.append(f"Intensity: {state['intensity']}")
        if state.get("effective_load") is not None:
            extras.append(f"Effective load: {state['effective_load']}")
        body = (
            f"Prompt: {state.get('prompt')}\n"
            f"Status: {nxt}\n"
            f"Updated: {stamp}\n"
            + ("\n".join(extras) + "\n" if extras else "")
            + f"\nLatest: {message}\n\nLog:\n{history_lines}\n- {stamp}: {nxt} — {message}\n"
        )
        await updateNote(
            note_id,
            body=body,
            tags=["exercise", "gym", nxt],
            compute_embedding=False,
        )
        await tag(note_id, ["exercise", "gym", nxt])

    state["gym_status"] = nxt
    state.setdefault("history", []).append(
        {"at": _now(), "status": nxt, "message": message, "mode": mode, "from": current}
    )

    stage = STATUS_TO_STAGE[nxt]
    coach = _coach_for(nxt, last_message=message)
    if mode == "stay":
        coach["guidance"] = "Still on this step — say what’s in the way and we’ll adjust."
    elif mode == "complete" or nxt == "log" and mode == "complete":
        stage = "DONE"
    if nxt == "log" and mode == "advance" and (mins or intensity):
        # one more beat then close on next, or close now if they gave full log from work
        if mins and intensity:
            stage = "DONE"
            state["gym_status"] = "log"

    if stage == "DONE":
        state["gym_status"] = "log"

    await _save_state(run_id, state, stage)
    await _append_step(
        run_id,
        stage,
        {"message": message, "from": current, "mode": mode},
        {
            "guided": True,
            "headline": coach["headline"],
            "guidance": coach["guidance"],
            "gym_status": state["gym_status"],
            "adapted": mode,
            "last_message": message,
        },
    )
    run = await _get_run(run_id)
    steps = await _steps_for(run_id)
    return _run_payload(run, state, steps)
