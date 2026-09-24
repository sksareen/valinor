"""
Deck endpoints: planner, completion, review.

  POST /api/deck/plan            draft candidate actions for a loop theme (pure)
  POST /api/deck/complete        close one action w/ proof enforcement (writes mem)
  GET  /api/deck/review/{loop}   aggregate a loop's timeline + next step (reads mem only)

/api/deck/plan and /api/deck/review never write memory. Closes go through
/api/deck/complete so the proof gate is enforced server-side.
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from typing import List, Optional

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import MemEvent, get_session
from memtrace import read_loop, serialize, write as mem_write

router = APIRouter(tags=["deck"])

PLANNER_MODEL = os.getenv("PLANNER_MODEL", "openai/gpt-4o-mini")


class CandidateAction(BaseModel):
    """One drafted action. Title + how ONLY — no priority, no verdict."""

    id: str
    title: str = Field(max_length=80)
    how: str


class PlanBatch(BaseModel):
    candidates: List[CandidateAction] = Field(min_length=4, max_length=6)


class PlanIn(BaseModel):
    theme: str = Field(min_length=1)
    comment: str = ""
    loop_id: Optional[str] = None  # passthrough echo; endpoint writes nothing
    model: Optional[str] = None


PLANNER_SYSTEM = (
    "You are a task-breakdown planner. Given a loop theme and the user's comment, "
    "draft 4 to 6 candidate actions that make the vague big thing concrete. "
    "Respond with ONLY valid JSON matching the schema. No markdown, no commentary.\n\n"
    "Rules:\n"
    "- title: imperative, under 80 chars, one action only.\n"
    "- how: 1-2 sentences naming the concrete first step and what 'done' looks like.\n"
    "- Every candidate must be small (under ~15 minutes) and startable right now.\n"
    "- Mix AI-doable work (drafting, looking up, listing, summarizing) with "
    "human-doable work (sending, deciding, going somewhere, opening something).\n"
    "- Include at least one candidate that kills blank-page dread (a draft, a "
    "template, a first-10 list) and one that forces a tiny visible artifact.\n"
    "- NEVER set priority, never rank, never judge — that is Jev's job. "
    "There is deliberately no priority field; do not smuggle ranking into titles.\n"
    "- Give each candidate a short unique id like c1, c2, ..."
)


def _plan_live(theme: str, comment: str, model: str) -> PlanBatch:
    from openrouter_client import OpenRouterClient  # lazy: needs OPENROUTER_API_KEY

    prompt = f"Theme: {theme.strip()}"
    if comment.strip():
        prompt += f"\nUser comment: {comment.strip()}"
    client = OpenRouterClient()
    return client.generate_structured(
        prompt,
        PlanBatch,
        system=PLANNER_SYSTEM,
        model=model,
        temperature=0.7,
    )


def _plan_fallback(theme: str) -> PlanBatch:
    """Templated candidates when the LLM is unreachable. Typed, deterministic."""
    t = theme.strip().rstrip(".")
    cands = [
        (
            f"Draft the first version of: {t}",
            f"Open a blank note and write the ugliest possible v1 of {t}. "
            "Done when 5+ lines exist; quality does not matter.",
        ),
        (
            f"Timebox 10 minutes on: {t}",
            f"Set a 10-minute timer and do only the smallest visible piece of {t}. "
            "Done when the timer ends and one artifact exists.",
        ),
        (
            f"List what you need from others for: {t}",
            f"Write down every input you are waiting on for {t} and who owes it. "
            "Done when each line has a name next to it.",
        ),
        (
            f"Capture what done looks like for: {t}",
            f"Write one sentence describing the finished state of {t}. "
            "Done when you could show it to someone and they would nod.",
        ),
    ]
    return PlanBatch(
        candidates=[
            CandidateAction(id=f"c{i+1}", title=title[:80], how=how)
            for i, (title, how) in enumerate(cands)
        ]
    )


# --- Classify: how much ceremony does this intent earn? --------------------
# The shapeshift move: recognize the SHAPE of the capture before spending the
# full 5-card deck on it. A vague big thing is a `mission` (plan -> judge ->
# pick -> do). One concrete startable thing is an `action` (skip breakdown,
# one step straight to Do). A thought with no verb is a `note` (capture, done).
# Pure — writes nothing. The deck logs the verdict as type intent.classified.

CLASSIFY_KINDS = ("mission", "action", "note")


class ClassifyIn(BaseModel):
    theme: str = Field(min_length=1)
    comment: str = ""
    model: Optional[str] = None


class Classification(BaseModel):
    kind: str = Field(description="one of: mission, action, note")
    confidence: float = Field(ge=0.0, le=1.0)
    reason: str = Field(default="", max_length=140)


CLASSIFY_SYSTEM = (
    "You route a captured intent into exactly how much process it earns. "
    "Respond with ONLY valid JSON matching the schema. No markdown, no commentary.\n\n"
    "kind is one of:\n"
    "- mission: a vague or multi-step thing that needs breaking down into "
    "several actions before it can be done (e.g. 'ship the guest list', "
    "'plan the offsite', 'get healthy'). Earns the full deck.\n"
    "- action: ONE concrete thing that is already startable in a single sitting "
    "with no breakdown (e.g. 'email Sam the invoice', 'book the dentist', "
    "'pay the credit card'). Skips breakdown, goes straight to doing it.\n"
    "- note: a thought, idea, or fact to remember with no action to take right "
    "now (e.g. 'the espresso place on 4th is good', 'idea: loops for teams'). "
    "Just gets captured.\n\n"
    "Bias toward `action` over `mission` when a single clear verb+object would "
    "finish it — most captures are smaller than they feel. confidence is 0..1."
)

# Keyword classifier — instant, offline, and the deterministic fallback when
# the model is unreachable. Mirrors the client-side chip so the two agree.
_ACTION_VERBS = (
    "call", "email", "text", "message", "send", "reply", "book", "pay", "buy",
    "order", "schedule", "cancel", "renew", "sign", "submit", "file", "post",
    "ask", "confirm", "check", "read", "watch", "download", "upload", "print",
)
_MISSION_WORDS = (
    "ship", "build", "plan", "organize", "organise", "launch", "design",
    "write", "prepare", "figure out", "sort out", "get started", "start on",
    "research", "learn", "set up", "overhaul", "redesign", "strategy",
)
_NOTE_LEADS = ("note:", "idea:", "remember", "thought:", "fyi", "reminder that")


def _classify_keyword(theme: str) -> Classification:
    t = theme.strip().lower()
    first = t.split()[0] if t.split() else ""
    if any(t.startswith(lead) for lead in _NOTE_LEADS):
        return Classification(kind="note", confidence=0.55, reason="reads as a thought, no action")
    if any(w in t for w in _MISSION_WORDS):
        return Classification(kind="mission", confidence=0.6, reason="broad verb — likely multi-step")
    words = len(t.split())
    if first in _ACTION_VERBS and words <= 9:
        return Classification(kind="action", confidence=0.65, reason="single imperative — one sitting")
    if words <= 4 and first not in _ACTION_VERBS:
        return Classification(kind="note", confidence=0.4, reason="fragment, no clear action")
    return Classification(kind="mission", confidence=0.45, reason="default — treat as a mission")


def _classify_live(theme: str, comment: str, model: str) -> Classification:
    from openrouter_client import OpenRouterClient  # lazy: needs OPENROUTER_API_KEY

    prompt = f"Captured intent: {theme.strip()}"
    if comment.strip():
        prompt += f"\nUser comment: {comment.strip()}"
    client = OpenRouterClient()
    c = client.generate_structured(
        prompt, Classification, system=CLASSIFY_SYSTEM, model=model, temperature=0.0,
        max_tokens=200,
    )
    if c.kind not in CLASSIFY_KINDS:  # model wandered off the enum — snap to keyword
        return _classify_keyword(theme)
    return c


@router.post("/api/deck/classify")
async def deck_classify(body: ClassifyIn):
    model = body.model or PLANNER_MODEL
    try:
        c = await asyncio.to_thread(_classify_live, body.theme, body.comment, model)
        fallback = False
        err = None
    except Exception as e:  # outage/auth — deterministic keyword verdict
        logger.warning("deck classify fallback: %s", e)
        c = _classify_keyword(body.theme)
        fallback = True
        err = "auth" if "401" in str(e) else "error"
    return {
        "kind": c.kind,
        "confidence": round(c.confidence, 2),
        "reason": c.reason,
        "model": model,
        "fallback": fallback,
        "error": err,
    }


@router.get("/api/deck/surface")
async def deck_surface(window: Optional[int] = None, limit: Optional[int] = None,
                       refresh: int = 0, sources: Optional[str] = None):
    """Surfaced birth: suggested missions from the ingest store. Cached — pass
    refresh=1 to force a fresh (costly) regeneration. Pure read, never writes."""
    from ingest_surface import surface_missions

    srcs = [s for s in (sources or "").split(",") if s.strip()] or None
    return await asyncio.to_thread(surface_missions, srcs, window, limit, bool(refresh))


@router.get("/api/deck/sources")
async def deck_sources(window: Optional[int] = None):
    """What ingest pulls from (counts + last-seen) + addable connectors."""
    from ingest_surface import sources_summary

    return await asyncio.to_thread(sources_summary, window)


@router.get("/api/deck/muse-connect")
async def muse_connect(request: Request):
    """Human-only paste card for Muse. Behind the preview gate, not the Muse key."""
    from muse import connect_instructions

    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    return await asyncio.to_thread(connect_instructions, host)


class ConsumeIn(BaseModel):
    title: str = ""


@router.post("/api/deck/consume")
async def deck_consume(body: ConsumeIn):
    """Mark a surfaced mission accepted/handled so it stops being suggested."""
    from ingest_surface import record_consumed

    return await asyncio.to_thread(record_consumed, body.title)


class RejectIn(BaseModel):
    title: str = ""
    theme: str = ""
    why: str = ""
    keys: List[str] = Field(default_factory=list)  # capture ids behind the suggestion


@router.post("/api/deck/reject")
async def deck_reject(body: RejectIn):
    """Reject a surfaced suggestion. Capture ids are stored so the same notes
    cannot come back under a rephrased title."""
    from ingest_surface import record_rejection

    if not (body.title.strip() or body.theme.strip()):
        raise HTTPException(status_code=400, detail="need a title or theme to reject")
    return await asyncio.to_thread(
        record_rejection, body.title, body.theme, body.why, list(body.keys)
    )


@router.post("/api/deck/plan")
async def deck_plan(body: PlanIn):
    model = body.model or PLANNER_MODEL
    try:
        batch = await asyncio.to_thread(_plan_live, body.theme, body.comment, model)
        fallback = False
        err = None
    except Exception as e:  # OpenRouter outage/auth — templated candidates
        logger.warning("deck plan fallback: %s", e)
        batch = _plan_fallback(body.theme)
        fallback = True
        err = "auth" if "401" in str(e) else "error"
    return {
        "candidates": [c.model_dump() for c in batch.candidates],
        "model": model,
        "fallback": fallback,
        "error": err,
        "loop_id": body.loop_id or f"loop-{uuid.uuid4().hex[:8]}",
    }


# --- Assist: a rough first pass so the user never faces a blank page --------
# Additive, pure (no memory writes). The deck's "let AI take a first pass" and
# AI-assigned actions call this; the close still goes through /api/deck/complete.

class AssistIn(BaseModel):
    title: str = Field(min_length=1)
    how: str = ""
    theme: str = ""
    comment: str = ""
    model: Optional[str] = None
    target: str = "internal"  # internal (now) | muse (later — see MUSE_INTEGRATION.md §6b)


ASSIST_SYSTEM = (
    "You draft a rough first pass so the user is never staring at a blank page. "
    "The goal is to UNBLOCK, not to be perfect or final. Output ONLY the draft "
    "itself — the message, list, or text the action calls for. No preamble, no "
    "explanation, no 'here is a draft', no markdown headers, no sign-off. Keep it "
    "short and immediately usable. If the action is to write a message, write the "
    "message. If it is to list things, produce the list."
)


def _assist_live(body: AssistIn, model: str) -> str:
    from openrouter_client import OpenRouterClient  # lazy: needs OPENROUTER_API_KEY

    ctx = f"Action: {body.title.strip()}"
    if body.how.strip():
        ctx += f"\nHow: {body.how.strip()}"
    if body.theme.strip():
        ctx += f"\nMission: {body.theme.strip()}"
    if body.comment.strip():
        ctx += f"\nAvoid / out of scope: {body.comment.strip()}"
    client = OpenRouterClient()
    resp = client.client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": ASSIST_SYSTEM},
            {"role": "user", "content": ctx},
        ],
        max_tokens=280,
        temperature=0.6,
    )
    return (resp.choices[0].message.content or "").strip()


def _assist_fallback(body: AssistIn) -> str:
    t = body.title.strip().rstrip(".")
    return (
        f"(rough first pass — offline)\n{t}:\n"
        "- one line, just to break the blank page\n"
        "- edit or delete freely — this only exists so you can start"
    )


@router.post("/api/deck/assist")
async def deck_assist(body: AssistIn):
    if (body.target or "internal") != "internal":
        raise HTTPException(
            status_code=501,
            detail="execute-via-muse is later — use target=internal for now",
        )
    model = body.model or PLANNER_MODEL
    try:
        draft = await asyncio.to_thread(_assist_live, body, model)
        if not draft:
            raise ValueError("empty draft")
        fallback = False
        err = None
    except Exception as e:  # outage/auth/empty — templated stub, deck keeps working
        logger.warning("deck assist fallback: %s", e)
        draft = _assist_fallback(body)
        fallback = True
        err = "auth" if "401" in str(e) else "error"
    return {"draft": draft, "model": model, "fallback": fallback, "error": err}


class Proof(BaseModel):
    kind: str = "text"  # text | link
    body: str = ""


class CompleteIn(BaseModel):
    loop_id: str = Field(min_length=1)
    candidate_id: str = Field(min_length=1)
    kind: str  # ai | human
    title: str = ""
    elapsed_s: int = 0
    proof: Optional[Proof] = None  # required for human
    result: str = ""  # required for ai


@router.post("/api/deck/complete")
async def deck_complete(body: CompleteIn, session: AsyncSession = Depends(get_session)):
    """Close one action. Human closes require proof; AI closes require a
    result. No proof/result → 400 and NOTHING is written to memory."""
    if body.kind == "human":
        if not body.proof or not body.proof.body.strip():
            raise HTTPException(status_code=400, detail="proof is required to close a human task")
        row = await mem_write(session, body.loop_id, "human.completed", "user", {
            "candidate_id": body.candidate_id,
            "title": body.title,
            "elapsed_s": max(0, body.elapsed_s),
            "proof": {"kind": body.proof.kind, "body": body.proof.body.strip()},
        })
    elif body.kind == "ai":
        if not body.result.strip():
            raise HTTPException(status_code=400, detail="result is required to close an AI task")
        row = await mem_write(session, body.loop_id, "ai.completed", "ai", {
            "candidate_id": body.candidate_id,
            "title": body.title,
            "result": body.result.strip(),
        })
    else:
        raise HTTPException(status_code=400, detail="kind must be ai or human")
    return {"id": row.id, "ts": row.ts.isoformat()}


# --- Review aggregation (reads memtrace only, never writes) ----------------

_REPLY_WORDS = ("sent", "texted", "emailed", "messaged", "asked", "called", "replied")


def _propose_next_step(
    titles: dict,
    verdicts: list,
    picked: dict,
    closed: set,
    humans: list,
    cluster_name: str,
    n_closed: int,
) -> Optional[dict]:
    """One optional next step, derived from loop data. Deterministic.

    Returns {label, theme, kind} so the review card can start a new mission
    or leftover task. kind is mission | task | pick.
    """
    for h in humans:
        body = ((h.get("proof") or {}).get("body") or "").lower()
        if any(w in body for w in _REPLY_WORDS):
            t = h.get("title") or titles.get(h.get("candidate_id"), "that task")
            return {
                "label": f"When they reply on '{t}', run the follow-up loop.",
                "theme": f"Follow up on {t}",
                "kind": "mission",
            }
    for v in verdicts:
        cid = v.get("candidate_id")
        if v.get("choice") == "schedule" and cid not in picked:
            title = titles.get(cid, cid)
            return {
                "label": f"Next up: '{title}' (Jev said schedule).",
                "theme": title,
                "kind": "mission",
            }
    for v in verdicts:
        cid = v.get("candidate_id")
        if v.get("choice") in ("do_now", "agent_does") and cid not in closed:
            title = titles.get(cid, cid)
            return {
                "label": f"Still open: '{title}.'",
                "theme": title,
                "kind": "task",
            }
    for v in verdicts:
        cid = v.get("candidate_id")
        if v.get("noul") == "needs_review" and cid in closed:
            title = titles.get(cid, cid)
            return {
                "label": f"Revisit for quality: '{title}' (Jev flagged needs_review).",
                "theme": title,
                "kind": "task",
            }
    if n_closed:
        return {
            "label": (
                f"Loop closed — {n_closed} chunk{'s' if n_closed != 1 else ''} done"
                + (f" on {cluster_name}." if cluster_name else ".")
                + " Start the next loop."
            ),
            "theme": "",
            "kind": "pick",
        }
    return None


@router.get("/api/deck/review/{loop_id}")
async def deck_review(loop_id: str, session: AsyncSession = Depends(get_session)):
    """Aggregate one loop: done items, human time, proofs, full timeline,
    plus one optional next-step proposal. Reads memtrace only."""
    rows = await read_loop(session, loop_id)
    if not rows:
        raise HTTPException(status_code=404, detail=f"no such loop: {loop_id}")
    events = [serialize(r) for r in rows]

    cluster, theme, comment = None, "", ""
    titles: dict = {}
    verdicts: list = []
    picked: dict = {}
    done, proofs, humans = [], [], []
    human_s = 0

    for ev in events:
        p = ev.get("payload") or {}
        t = ev.get("type")
        if t == "cluster.selected":
            cluster = {"key": p.get("cluster"), "name": p.get("name") or p.get("cluster")}
        elif t == "intent.confirmed":
            theme, comment = p.get("theme", ""), p.get("comment", "")
        elif t == "plan.drafted":
            for c in p.get("candidates") or []:
                titles[c.get("id")] = c.get("title", "")
        elif t == "jev.verdicts":
            verdicts = p.get("verdicts") or []
        elif t == "user.selection":
            for x in p.get("picked") or []:
                picked[x.get("candidate_id")] = x.get("assignee", "human")
                if x.get("title"):
                    titles.setdefault(x.get("candidate_id"), x["title"])
        elif t == "ai.completed":
            done.append({
                "candidate_id": p.get("candidate_id"),
                "title": p.get("title") or titles.get(p.get("candidate_id"), ""),
                "assignee": "ai",
                "result": (p.get("result") or "")[:280],
            })
        elif t == "human.completed":
            human_s += p.get("elapsed_s") or 0
            humans.append(p)
            proof = p.get("proof") or {}
            title = p.get("title") or titles.get(p.get("candidate_id"), "")
            done.append({
                "candidate_id": p.get("candidate_id"),
                "title": title,
                "assignee": "human",
                "elapsed_s": p.get("elapsed_s") or 0,
                "proof": proof,
            })
            proofs.append({"candidate_id": p.get("candidate_id"), "title": title,
                           "kind": proof.get("kind", "text"), "body": proof.get("body", "")})

    closed = {d["candidate_id"] for d in done}
    nxt = _propose_next_step(
        titles, verdicts, picked, closed, humans,
        (cluster or {}).get("name") or "", len(done),
    )
    return {
        "loop_id": loop_id,
        "cluster": cluster,
        "theme": theme,
        "comment": comment,
        "counts": {
            "events": len(events),
            "closed": len(done),
            "ai_closed": sum(1 for d in done if d["assignee"] == "ai"),
            "human_closed": sum(1 for d in done if d["assignee"] == "human"),
        },
        "human_s": human_s,
        "done": done,
        "proofs": proofs,
        "selection": [{"candidate_id": k, "assignee": v} for k, v in picked.items()],
        "next_step": (nxt or {}).get("label") if nxt else None,
        "next": nxt,
        "timeline": events,
    }


@router.get("/api/deck/loops")
async def deck_loops(limit: int = 20, session: AsyncSession = Depends(get_session)):
    """Completed loops, newest first: theme + closed counts + human time.
    Powers the 'N saved' history. Reads memtrace only."""
    limit = max(1, min(limit, 100))
    res = await session.execute(
        select(MemEvent)
        .where(MemEvent.type == "outcome.recorded")
        .order_by(MemEvent.ts.desc())
        .limit(limit)
    )
    outs = list(res.scalars().all())
    loops = []
    for o in outs:
        rows = await read_loop(session, o.loop_id)
        theme, closed, human_s, origin = "", 0, 0, "surfaced"
        for r in rows:
            ev = serialize(r)
            p = ev.get("payload") or {}
            if ev["type"] == "intent.confirmed" and not theme:
                theme = p.get("theme", "")
                if p.get("muse_id") or p.get("origin") == "muse":
                    origin = "muse"
                elif p.get("origin") == "declared" or p.get("declared"):
                    origin = "declared"
                elif p.get("origin"):
                    origin = str(p.get("origin"))
            elif ev["type"] == "human.completed":
                closed += 1
                human_s += p.get("elapsed_s") or 0
            elif ev["type"] == "ai.completed":
                closed += 1
        loops.append({
            "loop_id": o.loop_id,
            "theme": theme or ("Loop " + (o.ts.date().isoformat() if o.ts else "")),
            "closed": closed,
            "human_s": human_s,
            "origin": origin,
            "completed_at": o.ts.isoformat() if o.ts else None,
        })
    return {"loops": loops}
