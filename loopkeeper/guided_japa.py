"""
Guided Japa loop — pause at each practice stage, log a meditation note.
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

JAPA_STATUSES = ["sit", "practice", "log", "reflect", "done"]

STATUS_TO_STAGE = {
    "sit": "DISCOVER",
    "practice": "PLAN",
    "log": "EXECUTE",
    "reflect": "VERIFY",
    "done": "DONE",
}

STAGE_ORDER = ["DISCOVER", "PLAN", "EXECUTE", "VERIFY", "DONE"]

COACH: Dict[str, Dict[str, Any]] = {
    "sit": {
        "headline": "Sit and settle",
        "guidance": (
            "Find your seat. One breath. You’re about to practice — "
            "no need to perfect the setup."
        ),
        "question": "Are you seated and ready to begin?",
        "cta": "I’m sitting",
    },
    "practice": {
        "headline": "Do the practice",
        "guidance": (
            "Start your japa or meditation. Malas, timer, or open sits — "
            "whatever you planned. Stay with it."
        ),
        "question": "Finished the session, or still going?",
        "cta": "Practice done",
    },
    "log": {
        "headline": "Log the basics",
        "guidance": (
            "Capture duration in minutes and optional mala count "
            "(rounds of 108). Numbers only are fine."
        ),
        "question": "How long (minutes)? Any malas?",
        "cta": "Logged",
    },
    "reflect": {
        "headline": "Optional note",
        "guidance": (
            "Mantra name, quality of mind, or one line of what stayed with you. "
            "Skip if you want — empty is ok."
        ),
        "question": "Anything to remember from this sit?",
        "cta": "Save session",
    },
    "done": {
        "headline": "Session saved",
        "guidance": "Japa note written. Sit → practice → log → reflect → done.",
        "question": "",
        "cta": "Done",
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
        "japa_status": status,
        "loop_status": status,
        "headline": base["headline"],
        "guidance": base["guidance"],
        "question": base["question"],
        "cta": base["cta"],
        "last_message": last_message,
        "ring": JAPA_STATUSES,
    }


def _parse_metrics(message: str, state: Dict[str, Any]) -> None:
    text = message or ""
    m_min = re.search(r"(\d+)\s*(?:min|mins|minutes|m)\b", text, re.I)
    if not m_min:
        m_min = re.search(r"\b(\d{1,3})\b", text)
    if m_min:
        state["minutes"] = int(m_min.group(1))
    m_mala = re.search(r"(\d+)\s*(?:mala|malas|rounds?)\b", text, re.I)
    if m_mala:
        state["malas"] = int(m_mala.group(1))
    m_mantra = re.search(
        r"(?:mantra|chant)\s*[:=]?\s*([A-Za-z][A-Za-z\s\-']{1,40})", text, re.I
    )
    if m_mantra:
        state["mantra"] = m_mantra.group(1).strip()
    elif status_looks_like_name(text) and not m_min:
        state.setdefault("reflection", text.strip())


def status_looks_like_name(text: str) -> bool:
    t = (text or "").strip()
    return 2 <= len(t) <= 48 and not re.search(r"\d", t)


def _infer_status(message: str, current: str) -> Tuple[str, str]:
    text = (message or "").lower().strip()
    idx = JAPA_STATUSES.index(current)
    stay = ("stuck", "help", "not yet", "haven't", "still", "wait")
    if any(w in text for w in stay):
        return current, "stay"
    if current == "done":
        return "done", "complete"
    nxt = JAPA_STATUSES[min(idx + 1, len(JAPA_STATUSES) - 1)]
    if nxt == current:
        return current, "complete"
    return nxt, "advance"


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


def _note_body(state: Dict[str, Any]) -> str:
    lines = [
        f"Status: {state.get('japa_status', 'sit')}",
        f"Updated: {_now()}",
    ]
    if state.get("minutes") is not None:
        lines.append(f"Duration: {state['minutes']} min")
    if state.get("malas") is not None:
        lines.append(f"Malas: {state['malas']}")
    if state.get("mantra"):
        lines.append(f"Mantra: {state['mantra']}")
    if state.get("reflection"):
        lines.append(f"Note: {state['reflection']}")
    lines.append(f"Prompt: {state.get('prompt', '')}")
    return "\n".join(lines) + "\n"


def _run_payload(run: Run, state: Dict[str, Any], steps: List[Dict[str, Any]]) -> Dict[str, Any]:
    status = state.get("japa_status") or "sit"
    history = state.get("history") or []
    last_user = next(
        (h.get("message") for h in reversed(history) if h.get("mode") != "start"),
        None,
    )
    coach = _coach_for(status, last_message=last_user, coach_overrides=state.get("coach_overrides"))
    if run.status == "DONE":
        coach = {
            **coach,
            "headline": "Session saved",
            "guidance": "Your japa note is in. Sit → practice → log → reflect → done.",
            "question": "",
            "cta": "Done",
            "stage": "DONE",
            "japa_status": "done",
            "loop_status": "done",
        }
    return {
        "id": run.id,
        "guided": True,
        "loop": "japa",
        "intent": run.intent,
        "input_query": run.input_query,
        "status": run.status,
        "attempt": run.attempt,
        "max_attempts": run.max_attempts,
        "committed": run.committed,
        "japa_status": status,
        "loop_status": status,
        "note_id": state.get("note_id"),
        "minutes": state.get("minutes"),
        "malas": state.get("malas"),
        "mantra": state.get("mantra"),
        "coach": coach,
        "history": history,
        "steps": steps,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "updated_at": run.updated_at.isoformat() if run.updated_at else None,
    }


async def start_japa(prompt: str) -> Dict[str, Any]:
    prompt = (prompt or "").strip() or "Log my japa / meditation session."
    run_id = str(uuid.uuid4())
    title = f"Japa — {datetime.utcnow().strftime('%b %d %H:%M')}"
    state = {
        "guided": True,
        "loop": "japa",
        "prompt": prompt,
        "japa_status": "sit",
        "history": [{"at": _now(), "status": "sit", "message": prompt, "mode": "start"}],
    }
    note = await createNote(
        title=title,
        body=_note_body(state),
        tags=["japa", "meditation", "sit"],
        compute_embedding=False,
    )
    state["note_id"] = note["id"]
    state, _ = await apply_start_coach_override(
        loop_id="japa",
        prompt=prompt,
        first_status="sit",
        base_coach=dict(COACH["sit"]),
        state=state,
    )
    coach = _coach_for("sit", coach_overrides=state.get("coach_overrides"))

    async with async_session() as session:
        session.add(
            Run(
                id=run_id,
                intent="japa",
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
        {"guided": True, "japa_status": "sit", "note_id": note["id"], "headline": coach["headline"]},
    )

    run = await _get_run(run_id)
    steps = await _steps_for(run_id)
    return _run_payload(run, state, steps)


async def get_japa(run_id: str) -> Optional[Dict[str, Any]]:
    run = await _get_run(run_id)
    if not run:
        return None
    state = _loads(run.plan, {}) or {}
    if state.get("loop") != "japa":
        return None
    steps = await _steps_for(run_id)
    return _run_payload(run, state, steps)


async def respond_japa(run_id: str, message: str) -> Dict[str, Any]:
    message = (message or "").strip()
    if not message:
        raise ValueError("Say something about this step, or tap the next stage.")

    run = await _get_run(run_id)
    if not run:
        raise KeyError(run_id)
    state = _loads(run.plan, {}) or {}
    current = state.get("japa_status") or "sit"
    if run.status == "DONE" or current == "done":
        steps = await _steps_for(run_id)
        return _run_payload(run, state, steps)

    _parse_metrics(message, state)
    if current == "reflect" and message and not state.get("reflection"):
        state["reflection"] = message

    nxt, mode = _infer_status(message, current)
    state["japa_status"] = nxt
    state.setdefault("history", []).append(
        {"at": _now(), "status": nxt, "message": message, "mode": mode, "from": current}
    )

    note_id = state.get("note_id")
    if note_id:
        tags = ["japa", "meditation", nxt]
        await updateNote(note_id, body=_note_body(state), compute_embedding=False)
        await tag(note_id, tags)

    stage = STATUS_TO_STAGE[nxt]
    if nxt == "done" or mode == "complete":
        stage = "DONE"
        state["japa_status"] = "done"

    await _save_state(run_id, state, stage)
    await _append_step(
        run_id,
        stage,
        {"message": message, "from": current},
        {
            "guided": True,
            "japa_status": state["japa_status"],
            "mode": mode,
            "minutes": state.get("minutes"),
            "malas": state.get("malas"),
        },
    )

    run = await _get_run(run_id)
    steps = await _steps_for(run_id)
    return _run_payload(run, state, steps)
