"""
Guided personal loops for templates that aren't laundry/gym/japa-specific.
Shared pause-at-each-stage pattern with a progress ring + clickable stages.
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

STAGE_ORDER = ["DISCOVER", "PLAN", "EXECUTE", "VERIFY", "DONE"]

LOOP_DEFS: Dict[str, Dict[str, Any]] = {
    "sleep": {
        "statuses": ["recall", "hours", "quality", "note", "done"],
        "tags": ["sleep"],
        "title_prefix": "Sleep",
        "coach": {
            "recall": {
                "headline": "Recall last night",
                "guidance": "Think back to bedtime and wake. Rough memory is enough.",
                "question": "Ready to log last night’s sleep?",
                "cta": "Ready",
            },
            "hours": {
                "headline": "How many hours?",
                "guidance": "Total sleep time. Ballpark is fine (e.g. 7 or 6.5).",
                "question": "Hours slept?",
                "cta": "Logged hours",
            },
            "quality": {
                "headline": "Quality (optional)",
                "guidance": "Rate 1–5, or skip. 1 = rough, 5 = great.",
                "question": "Quality 1–5, or tap next to skip?",
                "cta": "Next",
            },
            "note": {
                "headline": "One line (optional)",
                "guidance": "Dreams, wake-ups, caffeine — or leave blank.",
                "question": "Anything else?",
                "cta": "Save sleep log",
            },
            "done": {
                "headline": "Sleep logged",
                "guidance": "Note saved with tag sleep.",
                "question": "",
                "cta": "Done",
            },
        },
    },
    "walk": {
        "statuses": ["shoes", "leave", "walk", "return", "log", "done"],
        "tags": ["walk"],
        "title_prefix": "Walk",
        "coach": {
            "shoes": {
                "headline": "Get ready",
                "guidance": "Shoes, keys, phone, water if you want. Keep it light — you’re going for a walk.",
                "question": "Ready at the door?",
                "cta": "Ready",
            },
            "leave": {
                "headline": "Step outside",
                "guidance": "Out the door. No optimizing the route yet — just leave.",
                "question": "Outside?",
                "cta": "Left",
            },
            "walk": {
                "headline": "Walk",
                "guidance": "Move. Block or park or loop around the block — whatever fits.",
                "question": "Still walking, or heading back?",
                "cta": "Walking / done moving",
            },
            "return": {
                "headline": "Head home",
                "guidance": "Turn around when it feels right. Getting back counts.",
                "question": "Back inside?",
                "cta": "Home",
            },
            "log": {
                "headline": "Log the walk",
                "guidance": "Minutes (rough is fine) and optional one-liner — route, weather, mood.",
                "question": "How long? Anything to note?",
                "cta": "Saved",
            },
            "done": {
                "headline": "Walk logged",
                "guidance": "Note saved with tag walk. Shoes → leave → walk → return → log → done.",
                "question": "",
                "cta": "Done",
            },
        },
    },
    "autoresearch": {
        "statuses": ["seed", "propose", "score", "decide", "done"],
        "tags": ["autoresearch"],
        "title_prefix": "Autoresearch",
        "coach": {
            "seed": {
                "headline": "Set the seed",
                "guidance": "One objective + a starting candidate. Keep it small.",
                "question": "What’s the objective and seed idea?",
                "cta": "Seed set",
            },
            "propose": {
                "headline": "Propose one neighbor",
                "guidance": "Change exactly one variable. No multi-edit.",
                "question": "What’s the single proposed change?",
                "cta": "Proposed",
            },
            "score": {
                "headline": "Score one metric",
                "guidance": "Name the metric and a rough score (0–1 or better/worse).",
                "question": "Metric + score?",
                "cta": "Scored",
            },
            "decide": {
                "headline": "Keep or discard",
                "guidance": "Keep only if the metric improved. Otherwise discard.",
                "question": "Keep or discard?",
                "cta": "Decision logged",
            },
            "done": {
                "headline": "Climb step saved",
                "guidance": "Seed → propose → score → decide. Run another loop to climb again.",
                "question": "",
                "cta": "Done",
            },
        },
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


def _status_to_stage(statuses: List[str], status: str) -> str:
    idx = statuses.index(status) if status in statuses else 0
    return STAGE_ORDER[min(idx, len(STAGE_ORDER) - 1)]


def _coach_for(
    defn: Dict[str, Any],
    loop_id: str,
    status: str,
    *,
    last_message: Optional[str] = None,
    coach_overrides: Optional[Dict[str, Dict[str, str]]] = None,
) -> Dict[str, Any]:
    statuses = defn["statuses"]
    base = merge_coach(
        defn["coach"].get(status)
        or {
            "headline": status.replace("_", " "),
            "guidance": "",
            "question": "Done with this step?",
            "cta": "Next",
        },
        (coach_overrides or {}).get(status),
    )
    stage = _status_to_stage(statuses, status)
    return {
        "stage": stage,
        "stage_number": (statuses.index(status) + 1) if status in statuses else 1,
        "stage_total": len(statuses),
        "loop_status": status,
        f"{loop_id}_status": status,
        "headline": base["headline"],
        "guidance": base["guidance"],
        "question": base["question"],
        "cta": base["cta"],
        "last_message": last_message,
        "ring": statuses,
    }


def _parse_sleep(message: str, state: Dict[str, Any], current: str) -> None:
    text = message or ""
    if current == "hours":
        m = re.search(r"(\d+(?:\.\d+)?)", text)
        if m:
            state["hours"] = float(m.group(1))
    elif current == "quality":
        m = re.search(r"\b([1-5])\b", text)
        if m:
            state["quality"] = int(m.group(1))
    elif current == "note" and text.strip():
        low = text.strip().lower()
        if low not in ("skip", "none", "n/a", "na", "next", "-"):
            state["note"] = text.strip()


def _parse_walk(message: str, state: Dict[str, Any], current: str) -> None:
    text = message or ""
    if current != "log":
        return
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:min|mins|minutes)?", text, re.I)
    if m:
        state["minutes"] = float(m.group(1))
    low = text.strip().lower()
    if low and low not in ("skip", "none", "n/a", "na", "next", "-", "saved", "done"):
        # Keep freeform note beyond just a number
        if not re.fullmatch(r"\d+(?:\.\d+)?\s*(?:min|mins|minutes)?", low):
            state["note"] = text.strip()


def _note_body(loop_id: str, state: Dict[str, Any]) -> str:
    lines = [
        f"Status: {state.get('loop_status', state.get(f'{loop_id}_status', ''))}",
        f"Updated: {_now()}",
        f"Prompt: {state.get('prompt', '')}",
    ]
    for key in ("hours", "quality", "minutes", "note", "seed", "proposal", "score", "decision"):
        if state.get(key) is not None:
            lines.append(f"{key.capitalize()}: {state[key]}")
    for r in (state.get("replies") or [])[-6:]:
        lines.append(f"- {r.get('status')}: {r.get('message')}")
    # history snippets for autoresearch
    if loop_id == "autoresearch":
        for h in (state.get("history") or [])[-4:]:
            if h.get("mode") != "start":
                lines.append(f"- {h.get('status')}: {h.get('message')}")
    return "\n".join(lines) + "\n"


def _infer(statuses: List[str], message: str, current: str) -> Tuple[str, str]:
    text = (message or "").lower().strip()
    idx = statuses.index(current)
    if any(w in text for w in ("stuck", "help", "not yet", "still", "wait")):
        return current, "stay"
    if current == statuses[-1]:
        return current, "complete"
    nxt = statuses[min(idx + 1, len(statuses) - 1)]
    return nxt, "advance" if nxt != current else "complete"


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


def _payload(
    loop_id: str,
    run: Run,
    state: Dict[str, Any],
    steps: List[Dict[str, Any]],
    defn: Dict[str, Any],
) -> Dict[str, Any]:
    statuses = defn["statuses"]
    status = state.get("loop_status") or state.get(f"{loop_id}_status") or statuses[0]
    history = state.get("history") or []
    last_user = next(
        (h.get("message") for h in reversed(history) if h.get("mode") != "start"),
        None,
    )
    coach = _coach_for(
        defn,
        loop_id,
        status,
        last_message=last_user,
        coach_overrides=state.get("coach_overrides"),
    )
    if run.status == "DONE":
        last = statuses[-1]
        coach = {
            **coach,
            **(defn["coach"].get(last) or {}),
            "stage": "DONE",
            "loop_status": last,
            f"{loop_id}_status": last,
            "ring": statuses,
            "stage_number": len(statuses),
            "stage_total": len(statuses),
        }
    return {
        "id": run.id,
        "guided": True,
        "loop": loop_id,
        "intent": run.intent,
        "input_query": run.input_query,
        "status": run.status,
        "attempt": run.attempt,
        "max_attempts": run.max_attempts,
        "committed": run.committed,
        "loop_status": status,
        f"{loop_id}_status": status,
        "note_id": state.get("note_id"),
        "coach": coach,
        "history": history,
        "steps": steps,
        "hours": state.get("hours"),
        "quality": state.get("quality"),
        "minutes": state.get("minutes"),
        "note": state.get("note"),
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "updated_at": run.updated_at.isoformat() if run.updated_at else None,
    }


async def _resolve(loop_id: str, state: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Resolve engine def: snapshot on run → builtin/custom registry."""
    if state and isinstance(state.get("defn"), dict) and state["defn"].get("statuses"):
        return state["defn"]
    from loop_templates import resolve_defn

    defn = await resolve_defn(loop_id)
    if not defn:
        raise ValueError(f"Unknown guided loop: {loop_id}")
    return defn


async def start_simple(loop_id: str, prompt: str) -> Dict[str, Any]:
    defn = await _resolve(loop_id)
    statuses = defn["statuses"]
    first = statuses[0]
    prompt = (prompt or "").strip() or f"Start {loop_id} loop"
    run_id = str(uuid.uuid4())
    title = f"{defn['title_prefix']} — {datetime.utcnow().strftime('%b %d %H:%M')}"
    state = {
        "guided": True,
        "loop": loop_id,
        "prompt": prompt,
        "loop_status": first,
        f"{loop_id}_status": first,
        "history": [{"at": _now(), "status": first, "message": prompt, "mode": "start"}],
        "defn": defn,  # snapshot so runs survive template edits/deletes
    }
    if loop_id == "autoresearch":
        state["seed"] = prompt

    base_coach = dict(defn["coach"].get(first) or {})
    state, defn = await apply_start_coach_override(
        loop_id=loop_id,
        prompt=prompt,
        first_status=first,
        base_coach=base_coach,
        state=state,
        defn=defn,
    )

    note = await createNote(
        title=title,
        body=_note_body(loop_id, state),
        tags=list(defn["tags"]) + [first],
        compute_embedding=False,
    )
    state["note_id"] = note["id"]
    stage = _status_to_stage(statuses, first)

    async with async_session() as session:
        session.add(
            Run(
                id=run_id,
                intent=loop_id,
                input_query=prompt,
                status=stage,
                attempt=1,
                max_attempts=1,
                committed=False,
                plan=_dumps(state),
            )
        )
        await session.commit()

    await _append_step(
        run_id,
        stage,
        {"prompt": prompt},
        {"guided": True, "loop": loop_id, "loop_status": first, "note_id": note["id"]},
    )
    run = await _get_run(run_id)
    return _payload(loop_id, run, state, await _steps_for(run_id), defn)


async def get_simple(loop_id: str, run_id: str) -> Optional[Dict[str, Any]]:
    run = await _get_run(run_id)
    if not run:
        return None
    state = _loads(run.plan, {}) or {}
    if state.get("loop") != loop_id:
        return None
    try:
        defn = await _resolve(loop_id, state)
    except ValueError:
        return None
    return _payload(loop_id, run, state, await _steps_for(run_id), defn)


async def respond_simple(loop_id: str, run_id: str, message: str) -> Dict[str, Any]:
    message = (message or "").strip()
    if not message:
        raise ValueError("Say something, or tap the next stage.")

    run = await _get_run(run_id)
    if not run:
        raise KeyError(run_id)
    state = _loads(run.plan, {}) or {}
    defn = await _resolve(loop_id, state)
    statuses = defn["statuses"]
    current = state.get("loop_status") or state.get(f"{loop_id}_status") or statuses[0]
    if run.status == "DONE" or current == statuses[-1]:
        return _payload(loop_id, run, state, await _steps_for(run_id), defn)

    if loop_id == "sleep":
        _parse_sleep(message, state, current)
    elif loop_id == "walk":
        _parse_walk(message, state, current)
    elif loop_id == "autoresearch":
        if current == "seed":
            state["seed"] = message
        elif current == "propose":
            state["proposal"] = message
        elif current == "score":
            state["score"] = message
        elif current == "decide":
            state["decision"] = message
    else:
        # Custom / generic: stash freeform replies as note fragments
        low = message.lower().strip()
        if low not in ("next", "skip", "done", "-", "continue"):
            hist_notes = state.setdefault("replies", [])
            hist_notes.append({"status": current, "message": message})
            state["note"] = message

    nxt, mode = _infer(statuses, message, current)
    state["loop_status"] = nxt
    state[f"{loop_id}_status"] = nxt
    state.setdefault("history", []).append(
        {"at": _now(), "status": nxt, "message": message, "mode": mode, "from": current}
    )
    state["defn"] = defn

    note_id = state.get("note_id")
    if note_id:
        await updateNote(note_id, body=_note_body(loop_id, state), compute_embedding=False)
        await tag(note_id, list(defn["tags"]) + [nxt])

    stage = _status_to_stage(statuses, nxt)
    if nxt == statuses[-1] or mode == "complete":
        stage = "DONE"
        state["loop_status"] = statuses[-1]
        state[f"{loop_id}_status"] = statuses[-1]

    await _save_state(run_id, state, stage)
    await _append_step(
        run_id,
        stage,
        {"message": message, "from": current},
        {"guided": True, "loop": loop_id, "loop_status": state["loop_status"], "mode": mode},
    )
    run = await _get_run(run_id)
    return _payload(loop_id, run, state, await _steps_for(run_id), defn)
