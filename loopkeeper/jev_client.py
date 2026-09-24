"""
Jev — the judge. Typed verdicts only, never prose.

One batch call judges every candidate action:
  Choice  do_now | agent_does | schedule | drop   (+ probability)
  Score   P1 | P2 | P3                            (+ probability)
  Noul    well_formed | needs_review               (+ probability)

The boundary is enforced by the Pydantic schema: anything that is not
valid verdict JSON fails validation and raises. Jev never writes memory
and never sees free-form instructions — candidates in, verdicts out.

Model: JEV_MODEL env var, default openai/gpt-4o-mini (fast + cheap,
good enough for narrow typed calls). Temperature 0 for determinism.
"""
from __future__ import annotations

import os
import time
from typing import List, Literal, Sequence

from pydantic import BaseModel, Field

JEV_MODEL = os.getenv("JEV_MODEL", "openai/gpt-4o-mini")

Choice = Literal["do_now", "agent_does", "schedule", "drop"]
Score = Literal["P1", "P2", "P3"]
Noul = Literal["well_formed", "needs_review"]


class JevVerdict(BaseModel):
    candidate_id: str
    choice: Choice
    choice_p: float = Field(ge=0.0, le=1.0)
    score: Score
    score_p: float = Field(ge=0.0, le=1.0)
    noul: Noul
    noul_p: float = Field(ge=0.0, le=1.0)


class JevBatch(BaseModel):
    verdicts: List[JevVerdict]


class Candidate(BaseModel):
    id: str
    title: str
    how: str = ""


JEV_SYSTEM = (
    "You are Jev, a fast action judge. For each candidate action you emit "
    "exactly one verdict with three typed fields plus a probability for each. "
    "Respond with ONLY valid JSON matching the schema. No markdown, no commentary.\n\n"
    "CHOICE (what to do with it):\n"
    "- do_now: a human should do this in this session. The DEFAULT for small, "
    "concrete human actions.\n"
    "- agent_does: an AI assistant can do this now (drafting, looking up, "
    "summarizing, listing). Prefer agent_does over do_now when no human-only "
    "step (send, go somewhere, decide in person, open a personal account) is required.\n"
    "- schedule: worthwhile but explicitly not today.\n"
    "- drop: RARE. Only for items that fight the loop theme, restate the theme "
    "instead of advancing it, or demand a decision the user explicitly deferred.\n"
    "Never drop for ordering: if B needs A first, that is sequencing, not a "
    "reason to drop — judge each candidate as if it can start now. Most batches "
    "should have 2+ do_now/agent_does verdicts. If you would drop more than half "
    "the batch, recheck: drop means 'not this loop', not 'later' (schedule) and "
    "not 'after another step' (still do_now/agent_does).\n\n"
    "SCORE (priority): P1 = moves the loop forward most; P2 = useful support; "
    "P3 = nice-to-have.\n\n"
    "NOUL (well-formedness — the 'can't help but start' test):\n"
    "- well_formed: concrete, small (under ~15 minutes), obvious first step, "
    "clear done condition.\n"
    "- needs_review: vague, too big, ambiguous done condition, or blocked on a "
    "decision or missing input.\n\n"
    "Probabilities are your confidence in each field (0-1). Judge each candidate "
    "independently. Emit one verdict per candidate, matching candidate_id exactly."
)


def judge(
    candidates: Sequence[Candidate],
    context: str = "",
    model: str | None = None,
) -> tuple[JevBatch, int]:
    """Judge every candidate in one batch call.

    Returns (verdicts, latency_ms). Raises ValueError if the model output
    fails schema validation or drops/adds candidates.
    """
    from openrouter_client import OpenRouterClient  # lazy: needs OPENROUTER_API_KEY

    if not candidates:
        raise ValueError("judge() needs at least one candidate")

    lines = [f"- id={c.id} | title={c.title} | how={c.how or '(none)'}" for c in candidates]
    prompt = "Candidates:\n" + "\n".join(lines)
    if context.strip():
        prompt += f"\n\nLoop context (theme + user comment):\n{context.strip()}"

    client = OpenRouterClient()
    start = time.time()
    batch = client.generate_structured(
        prompt,
        JevBatch,
        system=JEV_SYSTEM,
        model=model or JEV_MODEL,
        temperature=0.0,
    )
    latency_ms = int((time.time() - start) * 1000)

    _check_ids(candidates, batch)
    return batch, latency_ms


def _check_ids(candidates: Sequence[Candidate], batch: JevBatch) -> None:
    want = {c.id for c in candidates}
    got = [v.candidate_id for v in batch.verdicts]
    if set(got) != want or len(got) != len(want):
        raise ValueError(
            f"Jev verdict ids {got} do not match candidate ids {sorted(want)}"
        )


# --- Deterministic fallback (dead key / outage) ---------------------------
# Same typed output as the live judge, so the deck keeps working end to end.
# Responses built from this are flagged fallback=true; delete nothing when
# the key is fixed — the live path is tried first, always.

_AGENT_WORDS = ("draft", "write", "summarize", "look up", "pull", "search")
_DROP_WORDS = ("decide", "rule", "policy", "strategy", "choose between")
_DEFER_WORDS = ("later", "eventually", "someday", "roster", "tier")
_VAGUE_WORDS = ("figure out", "think about", "consider", "explore", "look into", "handle")


def fallback_judge(
    candidates: Sequence[Candidate],
    context: str = "",
) -> JevBatch:
    """Heuristic verdicts when the LLM is unreachable. Typed, deterministic."""
    ctx = context.lower()
    verdicts = []
    for i, c in enumerate(candidates):
        text = f"{c.title} {c.how}".lower()
        if any(w in text for w in _DROP_WORDS) and ("no " in ctx or "not today" in ctx):
            choice, cp = "drop", 0.71
        elif any(w in text for w in _AGENT_WORDS):
            choice, cp = "agent_does", 0.68
        elif any(w in text for w in _DEFER_WORDS):
            choice, cp = "schedule", 0.62
        else:
            choice, cp = "do_now", 0.75
        score, sp = (("P1", 0.7) if i == 0 else ("P2", 0.6) if i < 3 else ("P3", 0.55))
        if any(w in text for w in _VAGUE_WORDS) or len(c.title.split()) > 14:
            noul, np = "needs_review", 0.66
        else:
            noul, np = "well_formed", 0.72
        verdicts.append(
            JevVerdict(
                candidate_id=c.id,
                choice=choice,
                choice_p=cp,
                score=score,
                score_p=sp,
                noul=noul,
                noul_p=np,
            )
        )
    return JevBatch(verdicts=verdicts)
