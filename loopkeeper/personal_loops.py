"""
Registry of personal life-loop templates for the Valinor portal.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

PERSONAL_LOOPS: List[Dict[str, Any]] = [
    {
        "id": "laundry",
        "name": "Laundry",
        "description": "A guided Laundry loop that pauses, encourages, and adapts at every stage.",
        "default_query": "Help me do one load of laundry.",
        "guided": True,
        "stages": ["discover", "plan", "execute", "verify", "done"],
        "tags": ["personal", "chore"],
        "success_criteria_hints": [
            "Each mentioned load has a note tagged laundry",
            "Status tags reflect the current stage (started, washing, dried, folded, put_away)",
            "Note body includes a brief status update with when it changed",
            "Completed loads are tagged put_away",
        ],
        "metrics": ["loads_started", "loads_completed", "status"],
    },
    {
        "id": "sleep",
        "name": "Sleep",
        "description": "Guided sleep log: recall → hours → quality → note → done.",
        "default_query": (
            "Log last night's sleep as a new note tagged 'sleep'. "
            "Include hours slept and optional quality (1-5). Keep it brief and personal."
        ),
        "guided": True,
        "tags": ["personal", "health"],
        "success_criteria_hints": [
            "A new note is created with tag 'sleep'",
            "Note body records hours slept",
            "Optional quality rating (1-5) included when mentioned",
        ],
        "metrics": ["hours", "quality", "bedtime", "wake_time"],
    },
    {
        "id": "gym",
        "name": "Gym",
        "description": "Guided gym loop: decide → leave → arrive → work → log (minutes × intensity).",
        "default_query": (
            "Gym loop — I need to go to the gym or decide what exercise to do. "
            "I can leave in about 20 minutes."
        ),
        "guided": True,
        "tags": ["personal", "health", "fitness"],
        "success_criteria_hints": [
            "Session focus decided before leaving",
            "Workout completed and logged with minutes + intensity",
        ],
        "metrics": ["minutes", "intensity", "effective_load"],
    },
    {
        "id": "japa",
        "name": "Japa",
        "description": "Guided japa: sit → practice → log → reflect → done.",
        "default_query": (
            "Log my japa / meditation session as a new note tagged 'japa' and 'meditation'. "
            "Include duration in minutes, optional mala count (rounds of 108), and the mantra "
            "name if I mention it. Title like 'Japa — <date>' with a brief session summary "
            "and timestamp in the body."
        ),
        "guided": True,
        "tags": ["personal", "practice", "japa"],
        "success_criteria_hints": [
            "A new note is created with tags japa and meditation",
            "Note body records duration in minutes",
            "Optional mala count included when mentioned",
            "Mantra name recorded when provided",
        ],
        "metrics": ["minutes", "malas", "mantra"],
    },
    {
        "id": "walk",
        "name": "Walk",
        "description": "Guided walk: shoes → leave → walk → return → log → done.",
        "default_query": "I'm going on a walk. Help me get out the door and log it when I'm back.",
        "guided": True,
        "tags": ["personal", "health", "outdoors"],
        "success_criteria_hints": [
            "A new note is created with tag walk",
            "Note records approximate duration when mentioned",
        ],
        "metrics": ["minutes", "route", "mood"],
    },
    {
        "id": "autoresearch",
        "name": "Autoresearch",
        "description": (
            "Guided hill climb: seed → propose → score → decide → done."
        ),
        "default_query": (
            "Run an autoresearch hill-climb on a short research memo.\n"
            "objective: Clear greedy keep/discard research protocol with one metric\n"
            "seed: Propose one small change, score it, keep only improvements, repeat.\n"
            "Protocol: propose a neighbor → evaluate → keep if score improves → "
            "discard otherwise. Stop after patience rejects or max steps. "
            "Persist progress as notes tagged autoresearch."
        ),
        "guided": True,
        "tags": ["personal", "research", "autoresearch"],
        "success_criteria_hints": [
            "At least one climb step is recorded (keep or discard)",
            "Accepted steps never decrease the best score",
            "A note tagged autoresearch captures the best candidate and history",
            "Loop stops on patience or max_steps (not hung on LLM errors)",
        ],
        "metrics": ["best_score", "steps", "keeps", "discards", "stopped_reason"],
    },
]


def get_all_loops() -> List[Dict[str, Any]]:
    return list(PERSONAL_LOOPS)


def get_loop(loop_id: str) -> Optional[Dict[str, Any]]:
    for loop in PERSONAL_LOOPS:
        if loop["id"] == loop_id:
            return dict(loop)
    return None
