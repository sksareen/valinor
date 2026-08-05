"""
Karpathy-style greedy hill-climb (autoresearch).

Pattern (best practice from X/web discussion of karpathy/autoresearch):
  propose neighbor → evaluate one metric → keep if better, else discard → repeat
  until max_steps or patience (no improvement) is exhausted.

This module is intentionally thin: it does not replace the sealed DISCOVER→PLAN→
EXECUTE→VERIFY run-loop. It can persist climb progress as notes (tag: autoresearch)
and optionally surface as a dedicated run with step history.
"""
from __future__ import annotations

import json
import logging
import random
import re
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

AUTORESEARCH_TAG = "autoresearch"
AUTORESEARCH_MARKERS = (
    "autoresearch",
    "hill climb",
    "hill-climb",
    "hillclimbing",
    "greedy keep/discard",
    "propose → evaluate",
    "propose -> evaluate",
)


@dataclass
class ClimbStep:
    step: int
    proposal: str
    score: float
    accepted: bool
    mutation: str
    best_score: float


@dataclass
class ClimbResult:
    seed: str
    objective: str
    best_candidate: str
    best_score: float
    steps: List[ClimbStep] = field(default_factory=list)
    stopped_reason: str = "max_steps"
    note_ids: List[str] = field(default_factory=list)
    used_llm: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "seed": self.seed,
            "objective": self.objective,
            "best_candidate": self.best_candidate,
            "best_score": self.best_score,
            "steps": [asdict(s) for s in self.steps],
            "stopped_reason": self.stopped_reason,
            "note_ids": self.note_ids,
            "used_llm": self.used_llm,
        }


def is_autoresearch_query(query: str) -> bool:
    q = (query or "").lower()
    return any(m in q for m in AUTORESEARCH_MARKERS)


def _tokenize(text: str) -> List[str]:
    return [t for t in re.findall(r"[a-z0-9']+", (text or "").lower()) if len(t) > 2]


def heuristic_score(candidate: str, objective: str) -> float:
    """
    Deterministic 0–1 score used when OpenRouter is unavailable.

    Favors coverage of objective keywords, light structure, and moderate length.
    Fast and hang-proof for smoke tests.
    """
    cand = (candidate or "").strip()
    if not cand:
        return 0.0

    obj_tokens = set(_tokenize(objective))
    cand_tokens = _tokenize(cand)
    if not cand_tokens:
        return 0.0

    coverage = (
        len(obj_tokens & set(cand_tokens)) / len(obj_tokens) if obj_tokens else 0.5
    )
    # Prefer concise-but-complete candidates (~40–220 chars)
    n = len(cand)
    if n < 20:
        length_score = n / 20.0
    elif n <= 220:
        length_score = 1.0
    else:
        length_score = max(0.2, 1.0 - (n - 220) / 400.0)

    structure = 0.0
    if any(p in cand for p in (".", ";", ":", "—", "-")):
        structure += 0.35
    if re.search(r"\b(because|so that|to|for|via|using)\b", cand, re.I):
        structure += 0.35
    if cand[0].isupper() or cand[0].isdigit():
        structure += 0.3
    structure = min(1.0, structure)

    # Soft uniqueness — penalize extreme repetition
    uniq = len(set(cand_tokens)) / max(1, len(cand_tokens))
    score = 0.55 * coverage + 0.25 * length_score + 0.15 * structure + 0.05 * uniq
    return round(min(1.0, max(0.0, score)), 6)


def _deterministic_mutations(candidate: str, step: int) -> List[Tuple[str, str]]:
    """Structured neighbor ops (no LLM)."""
    c = candidate.strip()
    words = c.split()
    ops: List[Tuple[str, str]] = []

    clarifiers = [
        " Focus on one measurable metric.",
        " Keep changes minimal and reversible.",
        " Prefer simplicity when scores are close.",
        " State the hypothesis before mutating.",
        " Discard anything that does not improve the score.",
    ]
    ops.append((c + clarifiers[step % len(clarifiers)], "append_clarifier"))

    if len(words) > 6:
        # Drop a middle filler word
        idx = 2 + (step % max(1, len(words) - 4))
        shortened = " ".join(words[:idx] + words[idx + 1 :])
        ops.append((shortened, "drop_word"))

    if len(words) >= 4:
        swapped = words[:]
        i = step % (len(swapped) - 1)
        swapped[i], swapped[i + 1] = swapped[i + 1], swapped[i]
        ops.append((" ".join(swapped), "swap_adjacent"))

    # Prefix a keep/discard framing
    framed = f"Hill-climb: {c}" if not c.lower().startswith("hill-climb") else c
    if framed != c:
        ops.append((framed, "prefix_frame"))

    # Trim trailing fluff
    trimmed = re.sub(r"\s+", " ", c).strip(" .,;")
    if trimmed and trimmed != c:
        ops.append((trimmed + ".", "normalize"))

    return ops


def propose_neighbor(
    candidate: str,
    *,
    objective: str,
    step: int,
    history: List[ClimbStep],
    rng: random.Random,
    client: Any = None,
) -> Tuple[str, str, bool]:
    """
    Propose a neighbor candidate.

    Returns (proposal, mutation_name, used_llm).
    Falls back to deterministic ops on any LLM failure (incl. 401).
    """
    if client is not None:
        try:
            recent = [
                {
                    "step": h.step,
                    "accepted": h.accepted,
                    "score": h.score,
                    "mutation": h.mutation,
                    "proposal": h.proposal[:180],
                }
                for h in history[-4:]
            ]
            prompt = (
                "You are proposing ONE neighbor for a greedy hill-climb over text.\n"
                "Return ONLY the improved candidate text — no markdown, no commentary.\n"
                f"Objective: {objective}\n"
                f"Current best candidate:\n{candidate}\n"
                f"Recent attempts (JSON): {json.dumps(recent)}\n"
                "Make a small, testable mutation that might raise the score."
            )
            out = client.generate_response(
                prompt,
                max_tokens=220,
                temperature=0.4,
            )
            text = (out.get("response") or "").strip()
            # Strip accidental fences
            text = re.sub(r"^```(?:\w+)?\n?|\n?```$", "", text).strip()
            if text and text != candidate:
                return text, "llm_mutate", True
        except Exception as e:
            logger.warning(f"LLM propose failed, using deterministic mutation: {e}")

    ops = _deterministic_mutations(candidate, step)
    if not ops:
        return candidate + " (retry)", "noop_append", False
    # Prefer untried proposals
    tried = {h.proposal for h in history}
    fresh = [o for o in ops if o[0] not in tried]
    choice = rng.choice(fresh or ops)
    return choice[0], choice[1], False


async def hill_climb(
    seed: str,
    *,
    objective: str = (
        "Maximize clarity and coverage of a greedy hill-climb protocol: "
        "propose, evaluate one metric, keep if better, discard otherwise."
    ),
    max_steps: int = 8,
    patience: int = 3,
    score_fn: Optional[Callable[[str, str], float]] = None,
    client: Any = None,
    persist_notes: bool = True,
    rng_seed: Optional[int] = 7,
) -> ClimbResult:
    """
    Run a greedy hill-climb over a text candidate.

    - Accept only strict score improvements (classic hill climb).
    - Stop on max_steps or `patience` consecutive rejects.
    - Persist a progress note (and final best) when persist_notes=True.
    """
    score_fn = score_fn or heuristic_score
    rng = random.Random(rng_seed)
    # Disable LLM after first failure (e.g. 401) so smoke never hangs on retries.
    active_client = client

    current = (seed or "").strip() or (
        "Propose a small change, score it, keep only improvements, repeat."
    )
    best = current
    best_score = float(score_fn(best, objective))
    steps: List[ClimbStep] = []
    note_ids: List[str] = []
    used_llm = False
    stagnant = 0
    stopped = "max_steps"

    if persist_notes:
        try:
            from notes_store import createNote

            note = await createNote(
                title=f"Autoresearch climb — {datetime.utcnow().strftime('%Y-%m-%d %H:%M')}",
                body=(
                    f"objective: {objective}\n"
                    f"seed: {current}\n"
                    f"baseline_score: {best_score}\n"
                ),
                tags=[AUTORESEARCH_TAG, "climb", "started"],
                compute_embedding=False,
            )
            note_ids.append(note["id"])
        except Exception as e:
            logger.warning(f"Could not persist climb start note: {e}")

    for i in range(1, max_steps + 1):
        had_client = active_client is not None
        try:
            proposal, mutation, llm = propose_neighbor(
                best,
                objective=objective,
                step=i,
                history=steps,
                rng=rng,
                client=active_client,
            )
        except Exception as e:
            logger.warning(f"propose_neighbor crashed; disabling LLM: {e}")
            active_client = None
            proposal, mutation, llm = propose_neighbor(
                best,
                objective=objective,
                step=i,
                history=steps,
                rng=rng,
                client=None,
            )
            llm = False
        used_llm = used_llm or llm
        # After an LLM attempt that fell back to deterministic (401 etc.), stop retrying.
        if had_client and not llm:
            active_client = None
        score = float(score_fn(proposal, objective))
        accepted = score > best_score
        if accepted:
            best = proposal
            best_score = score
            stagnant = 0
        else:
            stagnant += 1

        step = ClimbStep(
            step=i,
            proposal=proposal,
            score=score,
            accepted=accepted,
            mutation=mutation,
            best_score=best_score,
        )
        steps.append(step)
        logger.info(
            "autoresearch step=%s accepted=%s score=%.4f best=%.4f mut=%s",
            i,
            accepted,
            score,
            best_score,
            mutation,
        )

        if stagnant >= patience:
            stopped = "patience"
            break

    if persist_notes:
        try:
            from notes_store import createNote, updateNote

            body_lines = [
                f"objective: {objective}",
                f"best_score: {best_score}",
                f"stopped: {stopped}",
                f"steps: {len(steps)}",
                f"used_llm: {used_llm}",
                "",
                "best_candidate:",
                best,
                "",
                "history:",
            ]
            for s in steps:
                flag = "keep" if s.accepted else "discard"
                body_lines.append(
                    f"  {s.step}. [{flag}] score={s.score:.4f} mut={s.mutation} :: {s.proposal[:120]}"
                )
            body = "\n".join(body_lines)

            if note_ids:
                updated = await updateNote(
                    note_ids[0],
                    title=f"Autoresearch best — score {best_score:.4f}",
                    body=body,
                    tags=[AUTORESEARCH_TAG, "climb", "done"],
                    compute_embedding=False,
                )
                note_ids[0] = updated["id"]
            else:
                note = await createNote(
                    title=f"Autoresearch best — score {best_score:.4f}",
                    body=body,
                    tags=[AUTORESEARCH_TAG, "climb", "done"],
                    compute_embedding=False,
                )
                note_ids.append(note["id"])
        except Exception as e:
            logger.warning(f"Could not persist climb result note: {e}")

    return ClimbResult(
        seed=seed,
        objective=objective,
        best_candidate=best,
        best_score=best_score,
        steps=steps,
        stopped_reason=stopped,
        note_ids=note_ids,
        used_llm=used_llm,
    )


def _extract_seed_and_objective(query: str) -> Tuple[str, str]:
    """Pull optional seed/objective from a freeform portal query."""
    objective = (
        "Maximize clarity of a greedy hill-climb research protocol: "
        "one candidate, one metric, propose → evaluate → keep if better → discard otherwise."
    )
    seed = (
        "Start from a simple research memo. Propose one small change at a time. "
        "Score against a single metric. Keep only improvements."
    )

    # Objective: ...
    m_obj = re.search(r"objective\s*:\s*(.+?)(?:\n|seed\s*:|$)", query, re.I | re.S)
    if m_obj:
        objective = m_obj.group(1).strip()

    m_seed = re.search(r"seed\s*:\s*(.+?)(?:\n|objective\s*:|$)", query, re.I | re.S)
    if m_seed:
        seed = m_seed.group(1).strip()
    elif not is_autoresearch_query(query):
        seed = query.strip() or seed
    else:
        # Use the query itself as a soft objective hint when no explicit seed
        if len(query.strip()) > 40:
            objective = query.strip()[:400]

    return seed, objective


async def run_as_loop(
    query: str,
    *,
    max_steps: int = 8,
    patience: int = 3,
    max_attempts: int = 3,
    run_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Drive hill_climb and persist a Run + RunStep history for the portal.

    Does not use staged seals (no note mutations via EXECUTE). Progress notes are
    written by hill_climb; the run record is observational.
    """
    from database import Run, async_session
    from run_loop import RunState, _append_step, _dumps, _get_openrouter_client, _update_run, get_run

    rid = run_id or str(uuid.uuid4())
    seed, objective = _extract_seed_and_objective(query)

    async with async_session() as session:
        session.add(
            Run(
                id=rid,
                input_query=query,
                intent="autoresearch hill-climb",
                status=RunState.DISCOVER.value,
                attempt=0,
                max_attempts=max_attempts,
                committed=False,
            )
        )
        await session.commit()

    client = _get_openrouter_client()
    await _append_step(
        rid,
        RunState.DISCOVER.value,
        input_data={"query": query},
        output_data={
            "mode": "autoresearch",
            "seed": seed,
            "objective": objective,
            "client": bool(client),
        },
    )

    await _update_run(rid, status=RunState.PLAN.value, attempt=1)
    await _append_step(
        rid,
        RunState.PLAN.value,
        input_data={"max_steps": max_steps, "patience": patience},
        output_data={
            "summary": "Greedy hill-climb: propose → score → keep if better",
            "success_criteria": [
                "At least one climb step is recorded",
                "Best score is non-decreasing across accepted steps",
                "A note tagged autoresearch captures the best candidate",
            ],
        },
    )

    await _update_run(rid, status=RunState.EXECUTE.value)
    result = await hill_climb(
        seed,
        objective=objective,
        max_steps=max_steps,
        patience=patience,
        client=client,
        persist_notes=True,
    )
    await _append_step(
        rid,
        RunState.EXECUTE.value,
        input_data={"seed": seed, "objective": objective},
        output_data={
            "climb": result.to_dict(),
            "mutate": False,
            "note": "hill-climb ran outside sealed staged diffs; notes are progress logs",
        },
    )

    # VERIFY — deterministic invariants
    scores_ok = True
    running_best = -1.0
    for s in result.steps:
        if s.accepted and s.score < running_best - 1e-9:
            scores_ok = False
        if s.accepted:
            running_best = max(running_best, s.score)
        if s.best_score + 1e-9 < running_best:
            scores_ok = False

    reasons: List[str] = []
    if not result.steps:
        reasons.append("No climb steps recorded")
    if not scores_ok:
        reasons.append("Accepted scores were not monotonically non-decreasing")
    if not result.note_ids:
        reasons.append("Missing autoresearch progress note")

    passed = not reasons
    await _append_step(
        rid,
        RunState.VERIFY.value,
        input_data={"best_score": result.best_score},
        output_data={
            "passed": passed,
            "reasons": reasons or ["Hill-climb invariants hold"],
            "best_candidate": result.best_candidate,
            "stopped_reason": result.stopped_reason,
        },
    )

    if passed:
        await _update_run(
            rid,
            status=RunState.DONE.value,
            committed=True,
            plan=_dumps(
                {
                    "mode": "autoresearch",
                    "best_score": result.best_score,
                    "note_ids": result.note_ids,
                }
            ),
            failure_reasons=None,
        )
        await _append_step(
            rid,
            RunState.DONE.value,
            input_data={"note_ids": result.note_ids},
            output_data=result.to_dict(),
        )
    else:
        await _update_run(
            rid,
            status=RunState.FAILED.value,
            committed=False,
            failure_reasons=_dumps(reasons),
        )
        await _append_step(
            rid,
            RunState.FAILED.value,
            input_data={"attempt": 1},
            output_data={"failure_reasons": reasons, "climb": result.to_dict()},
        )

    return await get_run(rid)
