"""
Persisted agentic run-loop:
DISCOVER → PLAN → EXECUTE (stage) → VERIFY → (ITERATE | DONE | FAILED)
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field
from sqlalchemy import select

from database import Run, RunStep, async_session
from notes_store import (
    apply_staged_diff,
    discover,
    get_note,
    note_exists,
)
from execute_safeguards import preflight_staged_diff, seal_staged_diff

logger = logging.getLogger(__name__)

ALLOWED_OPS = {"summarize", "tag", "link", "extract", "rewrite"}


class RunState(str, Enum):
    DISCOVER = "DISCOVER"
    PLAN = "PLAN"
    EXECUTE = "EXECUTE"
    VERIFY = "VERIFY"
    ITERATE = "ITERATE"
    DONE = "DONE"
    FAILED = "FAILED"


class IntentResult(BaseModel):
    intent: str = Field(description="Short paraphrase of what the user wants")
    scope: str = Field(
        default="notes",
        description="What may be mutated: notes|tags|links",
    )
    focus_note_ids: List[str] = Field(
        default_factory=list,
        description="Note IDs the user is focusing on, if any",
    )


class PlanOp(BaseModel):
    op: str = Field(description="One of: summarize, tag, link, extract, rewrite")
    note_id: Optional[str] = Field(default=None, description="Primary note this op targets")
    target_note_id: Optional[str] = Field(
        default=None, description="For link ops: destination note id"
    )
    tags: List[str] = Field(default_factory=list)
    rel: Optional[str] = Field(default="related")
    title: Optional[str] = None
    body: Optional[str] = None
    rationale: str = Field(default="")


class PlanResult(BaseModel):
    ops: List[PlanOp] = Field(default_factory=list)
    success_criteria: List[str] = Field(
        default_factory=list,
        description="Explicit criteria used by VERIFY",
    )
    summary: str = Field(default="")


class VerifyResult(BaseModel):
    passed: bool
    reasons: List[str] = Field(default_factory=list)
    score: float = Field(default=0.0, description="0-1 semantic grade")


def _dumps(obj: Any) -> str:
    return json.dumps(obj, default=str)


def _loads(text: Optional[str], default: Any = None) -> Any:
    if text is None:
        return default
    try:
        return json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return default


def run_to_dict(run: Run, steps: Optional[List[RunStep]] = None) -> Dict[str, Any]:
    return {
        "id": run.id,
        "intent": run.intent,
        "input_query": run.input_query,
        "status": run.status,
        "attempt": run.attempt,
        "max_attempts": run.max_attempts,
        "committed": run.committed,
        "plan": _loads(run.plan),
        "staged_diff": _loads(run.staged_diff),
        "failure_reasons": _loads(run.failure_reasons, []),
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "updated_at": run.updated_at.isoformat() if run.updated_at else None,
        "steps": [
            {
                "id": s.id,
                "state": s.state,
                "input": _loads(s.input),
                "output": _loads(s.output),
                "created_at": s.created_at.isoformat() if s.created_at else None,
            }
            for s in (steps or [])
        ],
    }


async def _append_step(
    run_id: str,
    state: str,
    input_data: Any = None,
    output_data: Any = None,
) -> None:
    async with async_session() as session:
        step = RunStep(
            id=str(uuid.uuid4()),
            run_id=run_id,
            state=state,
            input=_dumps(input_data) if input_data is not None else None,
            output=_dumps(output_data) if output_data is not None else None,
        )
        session.add(step)
        result = await session.execute(select(Run).where(Run.id == run_id))
        run = result.scalar_one()
        run.status = state
        run.updated_at = datetime.utcnow()
        await session.commit()


async def _update_run(run_id: str, **fields: Any) -> Run:
    async with async_session() as session:
        result = await session.execute(select(Run).where(Run.id == run_id))
        run = result.scalar_one()
        for k, v in fields.items():
            setattr(run, k, v)
        run.updated_at = datetime.utcnow()
        await session.commit()
        await session.refresh(run)
        return run


async def get_run(run_id: str) -> Optional[Dict[str, Any]]:
    async with async_session() as session:
        result = await session.execute(select(Run).where(Run.id == run_id))
        run = result.scalar_one_or_none()
        if not run:
            return None
        steps_result = await session.execute(
            select(RunStep)
            .where(RunStep.run_id == run_id)
            .order_by(RunStep.created_at.asc())
        )
        steps = list(steps_result.scalars().all())
        return run_to_dict(run, steps)


def _get_openrouter_client():
    try:
        from openrouter_client import OpenRouterClient

        return OpenRouterClient()
    except Exception as e:
        logger.error(f"OpenRouter client unavailable: {e}")
        return None


async def _stage_discover(query: str, client) -> Dict[str, Any]:
    candidates = await discover(query, limit=10)
    intent = IntentResult(intent=query, scope="notes", focus_note_ids=[c["id"] for c in candidates[:3]])
    if client:
        try:
            prompt = (
                "Parse the user request into intent for a notes agent.\n"
                f"User query: {query}\n"
                f"Candidate notes (id, title, score):\n"
                + "\n".join(
                    f"- {c['id']}: {c['title']} (score={c.get('score')})"
                    for c in candidates
                )
            )
            intent = client.generate_structured(prompt, IntentResult)
            # Keep focus ids that actually exist among candidates if model invents ids
            candidate_ids = {c["id"] for c in candidates}
            intent.focus_note_ids = [i for i in intent.focus_note_ids if i in candidate_ids] or [
                c["id"] for c in candidates[:3]
            ]
        except Exception as e:
            logger.warning(f"Intent parse failed, using fallback: {e}")
    return {"intent": intent.model_dump(), "candidates": candidates}


def _fallback_plan(query: str, candidates: List[Dict[str, Any]]) -> PlanResult:
    """Deterministic plan when LLM is unavailable."""
    ops: List[PlanOp] = []
    if candidates:
        ops.append(
            PlanOp(
                op="tag",
                note_id=candidates[0]["id"],
                tags=["processed"],
                rationale="Fallback: mark top candidate",
            )
        )
        ops.append(
            PlanOp(
                op="rewrite",
                title=f"Summary: {candidates[0]['title']}",
                body=f"Summary of '{candidates[0]['title']}': {candidates[0]['body'][:280]}",
                tags=["summary"],
                rationale="Fallback: create a summary note",
            )
        )
    else:
        ops.append(
            PlanOp(
                op="rewrite",
                title="Untitled from query",
                body=query,
                tags=["inbox"],
                rationale="Fallback: create a new note from the query",
            )
        )
    return PlanResult(
        ops=ops,
        success_criteria=[
            "At least one note op is staged and references valid ids or creates a note"
        ],
        summary="Fallback plan (no LLM)",
    )


async def _stage_plan(
    query: str,
    intent: Dict[str, Any],
    candidates: List[Dict[str, Any]],
    failure_reasons: Optional[List[str]],
    attempt: int,
    client,
) -> PlanResult:
    if not client:
        return _fallback_plan(query, candidates)

    failure_block = ""
    if failure_reasons:
        failure_block = (
            f"\nPrevious attempt {attempt} failed for these reasons:\n"
            + "\n".join(f"- {r}" for r in failure_reasons)
            + "\nProduce a revised plan that addresses them.\n"
        )

    notes_block = "\n".join(
        f"- id={c['id']} title={c['title']!r} tags={c.get('tags')} "
        f"body_preview={c['body'][:160]!r}"
        for c in candidates
    ) or "(no candidate notes)"

    prompt = (
        "Create an ordered plan of note operations for the user request.\n"
        f"User query: {query}\n"
        f"Parsed intent: {json.dumps(intent)}\n"
        f"Candidate notes:\n{notes_block}\n"
        f"{failure_block}\n"
        "Allowed op values: summarize, tag, link, extract, rewrite.\n"
        "For rewrite/summarize/extract that create NEW notes, omit note_id and set title+body.\n"
        "For tag/link/summarize on existing notes, set note_id to a real candidate id.\n"
        "For link, also set target_note_id.\n"
        "Include explicit success_criteria the verifier can grade against.\n"
    )
    try:
        return client.generate_structured(prompt, PlanResult)
    except Exception as e:
        logger.warning(f"Plan LLM failed, using fallback: {e}")
        return _fallback_plan(query, candidates)


def _plan_op_to_staged(op: PlanOp) -> Dict[str, Any]:
    """Map a high-level plan op onto notes_store staged primitives."""
    if op.op == "tag":
        return {
            "op": "tag",
            "payload": {"note_id": op.note_id, "tags": op.tags or ["auto"]},
            "source": op.model_dump(),
        }
    if op.op == "link":
        return {
            "op": "linkNotes",
            "payload": {
                "src_note_id": op.note_id,
                "dst_note_id": op.target_note_id,
                "rel": op.rel or "related",
            },
            "source": op.model_dump(),
        }
    if op.op in ("summarize", "extract", "rewrite"):
        # Existing note → update body/title; no note_id → create
        if op.note_id:
            payload: Dict[str, Any] = {"note_id": op.note_id}
            if op.title is not None:
                payload["title"] = op.title
            if op.body is not None:
                payload["body"] = op.body
            if op.tags:
                payload["tags"] = op.tags
            return {"op": "updateNote", "payload": payload, "source": op.model_dump()}
        return {
            "op": "createNote",
            "payload": {
                "title": op.title or f"{op.op.title()} note",
                "body": op.body or "",
                "tags": op.tags or [op.op],
            },
            "source": op.model_dump(),
        }
    raise ValueError(f"Unsupported plan op: {op.op}")


async def _stage_execute(plan: PlanResult) -> Dict[str, Any]:
    """
    Stage ops only — never mutate live notes.

    Safeguard 1: preflight dry-run must pass before the stage is sealed.
    Safeguard 2: seal under content_hash so commit applies the exact artifact.
    """
    staged_ops = []
    for op in plan.ops:
        if op.op not in ALLOWED_OPS:
            continue
        staged_ops.append(_plan_op_to_staged(op))
    # Always embed notes we touch so future discover works
    for staged in list(staged_ops):
        note_id = staged.get("payload", {}).get("note_id")
        if note_id:
            staged_ops.append(
                {"op": "embed", "payload": {"note_id": note_id}, "source": {"auto": True}}
            )

    draft = {"ops": staged_ops, "mutate": False}
    preflight = await preflight_staged_diff(draft)
    if not preflight["ok"]:
        return {
            "ops": staged_ops,
            "sealed": False,
            "mutate": False,
            "preflight": preflight,
            "content_hash": None,
        }

    sealed = seal_staged_diff(staged_ops)
    sealed["preflight"] = preflight
    return sealed



async def _deterministic_verify(
    plan: PlanResult,
    staged: Dict[str, Any],
    intent: Dict[str, Any],
) -> List[str]:
    reasons: List[str] = []
    if not plan.ops:
        reasons.append("Plan has no ops")
    for op in plan.ops:
        if op.op not in ALLOWED_OPS:
            reasons.append(f"Invalid op: {op.op}")
        if op.op in ("tag", "link") and not op.note_id:
            reasons.append(f"{op.op} missing note_id")
        if op.op == "link" and not op.target_note_id:
            reasons.append("link missing target_note_id")
        if op.note_id and not await note_exists(op.note_id):
            # Creating new notes via rewrite/summarize/extract without note_id is fine;
            # referencing a missing id is not.
            reasons.append(f"Referenced note_id does not exist: {op.note_id}")
        if op.target_note_id and not await note_exists(op.target_note_id):
            reasons.append(f"Referenced target_note_id does not exist: {op.target_note_id}")

    focus = set(intent.get("focus_note_ids") or [])
    scope = intent.get("scope") or "notes"
    if scope not in ("notes", "tags", "links"):
        reasons.append(f"Out of scope: {scope}")

    # Soft scope check: if focus ids provided, prefer ops that touch them
    if focus:
        touched = set()
        for op in plan.ops:
            if op.note_id:
                touched.add(op.note_id)
            if op.target_note_id:
                touched.add(op.target_note_id)
        if touched and not (touched & focus) and not any(
            o.op in ("rewrite", "extract", "summarize") and not o.note_id for o in plan.ops
        ):
            reasons.append("Plan does not touch any focus note ids and creates nothing new")

    if not (staged.get("ops") or []):
        reasons.append("Staged diff is empty")

    if not staged.get("sealed") or not staged.get("content_hash"):
        reasons.append("Staged diff is not sealed (Execute safeguard)")

    if staged.get("mutate") is True:
        reasons.append("Staged diff illegally requests mutation during Execute")

    if not plan.success_criteria:
        reasons.append("Plan missing success_criteria")

    return reasons


async def _semantic_verify(
    query: str,
    plan: PlanResult,
    staged: Dict[str, Any],
    client,
) -> VerifyResult:
    if not client:
        return VerifyResult(
            passed=True,
            reasons=["No LLM available; deterministic checks only"],
            score=1.0,
        )

    prompt = (
        "Grade whether the staged note operations satisfy the plan's success criteria.\n"
        f"User query: {query}\n"
        f"Plan: {plan.model_dump_json()}\n"
        f"Staged diff: {json.dumps(staged)}\n"
        "Return passed=true only if criteria are likely met. Include short reasons."
    )
    try:
        return client.generate_structured(prompt, VerifyResult)
    except Exception as e:
        logger.warning(f"Semantic verify failed, deferring to deterministic checks: {e}")
        return VerifyResult(
            passed=True,
            reasons=[f"Semantic verify skipped ({e})"],
            score=1.0,
        )


async def start_run(
    query: str,
    *,
    max_attempts: int = 3,
    run_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Create a run and drive it through the state machine to a terminal state."""
    # Thin hook: Karpathy-style hill-climb without rewriting the sealed stagegate.
    try:
        from autoresearch import is_autoresearch_query, run_as_loop

        if is_autoresearch_query(query):
            return await run_as_loop(
                query,
                max_attempts=max_attempts,
                run_id=run_id,
            )
    except Exception as e:
        logger.warning(f"Autoresearch hook failed, falling through to notes loop: {e}")

    rid = run_id or str(uuid.uuid4())
    async with async_session() as session:
        run = Run(
            id=rid,
            input_query=query,
            status=RunState.DISCOVER.value,
            attempt=0,
            max_attempts=max_attempts,
            committed=False,
        )
        session.add(run)
        await session.commit()

    client = _get_openrouter_client()

    # --- DISCOVER ---
    discover_out = await _stage_discover(query, client)
    intent = discover_out["intent"]
    candidates = discover_out["candidates"]
    await _update_run(rid, intent=intent.get("intent"), status=RunState.DISCOVER.value)
    await _append_step(rid, RunState.DISCOVER.value, input_data={"query": query}, output_data=discover_out)

    failure_reasons: List[str] = []
    attempt = 0

    while attempt < max_attempts:
        attempt += 1
        await _update_run(rid, attempt=attempt, failure_reasons=_dumps(failure_reasons) if failure_reasons else None)

        if failure_reasons:
            await _append_step(
                rid,
                RunState.ITERATE.value,
                input_data={"attempt": attempt, "failure_reasons": failure_reasons},
                output_data={"next": RunState.PLAN.value},
            )

        # --- PLAN ---
        plan = await _stage_plan(query, intent, candidates, failure_reasons or None, attempt, client)
        await _update_run(rid, plan=_dumps(plan.model_dump()), status=RunState.PLAN.value)
        await _append_step(
            rid,
            RunState.PLAN.value,
            input_data={"attempt": attempt, "failure_reasons": failure_reasons},
            output_data=plan.model_dump(),
        )

        # --- EXECUTE (stage only — never mutates) ---
        staged = await _stage_execute(plan)
        await _update_run(rid, staged_diff=_dumps(staged), status=RunState.EXECUTE.value)
        await _append_step(
            rid,
            RunState.EXECUTE.value,
            input_data=plan.model_dump(),
            output_data=staged,
        )

        # Preflight failure is an Execute bug catch — iterate without committing
        if not staged.get("sealed") or not (staged.get("preflight") or {}).get("ok", False):
            pf_errors = (staged.get("preflight") or {}).get("errors") or ["Execute preflight failed"]
            failure_reasons = [f"execute_preflight: {e}" for e in pf_errors]
            await _update_run(rid, failure_reasons=_dumps(failure_reasons))
            if attempt >= max_attempts:
                break
            continue

        # --- VERIFY ---
        det_reasons = await _deterministic_verify(plan, staged, intent)
        semantic = await _semantic_verify(query, plan, staged, client)
        passed = (not det_reasons) and semantic.passed
        verify_out = {
            "deterministic_reasons": det_reasons,
            "semantic": semantic.model_dump(),
            "passed": passed,
            "sealed_hash": staged.get("content_hash"),
        }
        await _append_step(
            rid,
            RunState.VERIFY.value,
            input_data={"plan": plan.model_dump(), "staged_diff": staged},
            output_data=verify_out,
        )

        if passed:
            # Commit sealed artifact only; rollback journal on failure
            try:
                commit_out = await apply_staged_diff(staged, require_seal=True)
            except Exception as e:
                failure_reasons = [f"commit_failed: {e}"]
                await _update_run(rid, failure_reasons=_dumps(failure_reasons))
                if attempt >= max_attempts:
                    break
                continue

            await _update_run(
                rid,
                status=RunState.DONE.value,
                committed=True,
                failure_reasons=None,
            )
            await _append_step(
                rid,
                RunState.DONE.value,
                input_data={"content_hash": staged.get("content_hash")},
                output_data=commit_out,
            )
            return await get_run(rid)

        failure_reasons = det_reasons + list(semantic.reasons or [])
        await _update_run(rid, failure_reasons=_dumps(failure_reasons))

        if attempt >= max_attempts:
            break
        # else: loop → ITERATE → PLAN

    await _update_run(rid, status=RunState.FAILED.value)
    await _append_step(
        rid,
        RunState.FAILED.value,
        input_data={"attempt": attempt},
        output_data={"failure_reasons": failure_reasons},
    )
    return await get_run(rid)
