"""
Personalize guided-loop coach copy at loop start via OpenRouter.
Falls back silently to static coach when LLM is unavailable.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

COACH_KEYS = ("headline", "guidance", "question", "cta")


class CoachCopy(BaseModel):
    headline: str = Field(..., max_length=120, description="Short stage title")
    guidance: str = Field(..., max_length=500, description="Warm, practical coaching paragraph")
    question: str = Field(..., max_length=200, description="One question for the user")
    cta: str = Field(..., max_length=40, description="Continue button label")


def _get_client():
    try:
        from openrouter_client import OpenRouterClient

        return OpenRouterClient()
    except Exception as e:
        logger.warning(f"OpenRouter unavailable for coach personalization: {e}")
        return None


def merge_coach(base: Dict[str, Any], override: Optional[Dict[str, str]]) -> Dict[str, Any]:
    """Merge LLM override fields onto static coach copy."""
    out = dict(base)
    if not override:
        return out
    for key in COACH_KEYS:
        val = override.get(key)
        if isinstance(val, str) and val.strip():
            out[key] = val.strip()
    return out


async def personalize_coach(
    loop_id: str,
    prompt: str,
    base_coach: Dict[str, str],
    *,
    status: str,
) -> Optional[Dict[str, str]]:
    """
    Tailor stage-1 coach copy from the user's start prompt.
    Returns override dict or None on failure (caller keeps static coach).
    """
    client = _get_client()
    if not client:
        return None

    prompt = (prompt or "").strip()
    if not prompt:
        return None

    user_prompt = (
        f"Loop type: {loop_id}\n"
        f"Stage id: {status}\n"
        f"User start prompt: {prompt}\n\n"
        "Default coach copy for this stage:\n"
        f"- headline: {base_coach.get('headline', '')}\n"
        f"- guidance: {base_coach.get('guidance', '')}\n"
        f"- question: {base_coach.get('question', '')}\n"
        f"- cta: {base_coach.get('cta', '')}\n\n"
        "Rewrite ONLY this first step's coach copy to reflect the user's prompt.\n"
        "Tone: warm, plain, second-person, encouraging — never scolding.\n"
        "Keep it brief. One clear action. Do not mention AI or loops as a product.\n"
        "Stay on the same stage — do not skip ahead or add extra steps."
    )
    system = (
        "You personalize guided habit coach copy for a personal loops app. "
        "Output JSON matching the schema exactly."
    )

    try:
        result = await asyncio.to_thread(
            client.generate_structured,
            user_prompt,
            CoachCopy,
            system=system,
            max_tokens=600,
            temperature=0.4,
        )
        return result.model_dump()
    except Exception as e:
        logger.warning(f"Coach personalization failed for {loop_id}/{status}: {e}")
        return None


async def apply_start_coach_override(
    *,
    loop_id: str,
    prompt: str,
    first_status: str,
    base_coach: Dict[str, str],
    state: Dict[str, Any],
    defn: Optional[Dict[str, Any]] = None,
) -> tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
    """
    Call LLM, persist coach_overrides on state, optionally snapshot into defn.coach.
    Returns (state, defn).
    """
    override = await personalize_coach(loop_id, prompt, base_coach, status=first_status)
    if not override:
        return state, defn

    state = {**state, "coach_overrides": {first_status: override}}

    if defn is not None:
        coach = dict(defn.get("coach") or {})
        stage_coach = dict(coach.get(first_status) or base_coach)
        coach[first_status] = merge_coach(stage_coach, override)
        defn = {**defn, "coach": coach}
        state["defn"] = defn

    return state, defn
