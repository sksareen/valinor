"""
Builtin + custom loop template registry.

Custom templates live in SQLite (LoopTemplate). Builtins stay in code.
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import select

from database import LoopTemplate, async_session
from guided_simple import LOOP_DEFS
from personal_loops import PERSONAL_LOOPS, get_loop as get_builtin_meta

RESERVED_IDS = {
    "laundry",
    "gym",
    "japa",
    "sleep",
    "walk",
    "autoresearch",
    "exercise",
    "notes",
    "loop",
    "custom",
    "runs",
    "templates",
    "events",
}

# Special engines that aren't guided_simple
SPECIAL_ENGINES = {"laundry", "gym", "japa", "exercise"}

_DEFAULT_COLORS = [
    "#7a9e6a",
    "#9e7a6a",
    "#6a7a9e",
    "#9e6a8a",
    "#6a9e8a",
    "#9e9e6a",
    "#8a6a9e",
]


def _dumps(obj: Any) -> str:
    return json.dumps(obj, default=str)


def _loads(text: Optional[str], default: Any = None) -> Any:
    if not text:
        return default
    try:
        return json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return default


def slugify(text: str, *, fallback: str = "loop") -> str:
    s = (text or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s or fallback


def slugify_stage(label: str, idx: int) -> str:
    return slugify(label, fallback=f"step_{idx + 1}")


def coach_from_labels(labels: List[str]) -> Dict[str, Dict[str, str]]:
    """Build default coach copy from human stage labels."""
    coach: Dict[str, Dict[str, str]] = {}
    n = len(labels)
    for i, label in enumerate(labels):
        sid = slugify_stage(label, i)
        is_last = i == n - 1
        nice = label.strip() or sid.replace("_", " ")
        coach[sid] = {
            "headline": nice[:1].upper() + nice[1:] if nice else sid,
            "guidance": (
                f"Finish this loop. Optional note goes in your reply."
                if is_last
                else f"Do this: {nice}. Tap Continue when it’s done."
            ),
            "question": "Anything to note?" if is_last else "Done with this step?",
            "cta": "Done" if is_last else "Next",
        }
    return coach


def statuses_from_labels(labels: List[str]) -> List[str]:
    out: List[str] = []
    seen = set()
    for i, label in enumerate(labels):
        sid = slugify_stage(label, i)
        base = sid
        n = 2
        while sid in seen:
            sid = f"{base}_{n}"
            n += 1
        seen.add(sid)
        out.append(sid)
    return out


def normalize_stage_labels(raw: List[str]) -> List[str]:
    labels = [str(x).strip() for x in (raw or []) if str(x).strip()]
    if len(labels) < 2:
        raise ValueError("Need at least 2 stages")
    if len(labels) > 12:
        raise ValueError("Max 12 stages")
    # Ensure a clear finish stage
    last = slugify(labels[-1])
    if last not in ("done", "finish", "complete", "log"):
        labels.append("Done")
    return labels


def color_for_id(loop_id: str) -> str:
    h = sum(ord(c) for c in loop_id) if loop_id else 0
    return _DEFAULT_COLORS[h % len(_DEFAULT_COLORS)]


def defn_from_row(row: LoopTemplate) -> Dict[str, Any]:
    statuses = _loads(row.statuses_json, []) or []
    coach = _loads(row.coach_json, {}) or {}
    tags = _loads(row.tags_json, []) or [row.id]
    return {
        "statuses": statuses,
        "tags": tags,
        "title_prefix": row.name or row.id.title(),
        "coach": coach,
    }


def template_public(
    *,
    loop_id: str,
    name: str,
    description: str = "",
    default_query: str = "",
    guided: bool = True,
    tags: Optional[List[str]] = None,
    custom: bool = False,
    color: Optional[str] = None,
    engine: str = "simple",
    statuses: Optional[List[str]] = None,
    coach: Optional[Dict[str, Any]] = None,
    metrics: Optional[List[str]] = None,
) -> Dict[str, Any]:
    statuses = list(statuses or [])
    coach = dict(coach or {})
    stage_catalog = {
        sid: {
            "headline": (coach.get(sid) or {}).get("headline") or sid.replace("_", " "),
            "guidance": (coach.get(sid) or {}).get("guidance") or "",
            "question": (coach.get(sid) or {}).get("question") or "",
            "cta": (coach.get(sid) or {}).get("cta") or "Next",
        }
        for sid in statuses
    }
    out: Dict[str, Any] = {
        "id": loop_id,
        "name": name,
        "description": description,
        "default_query": default_query,
        "guided": guided,
        "tags": list(tags or []),
        "custom": custom,
        "color": color or color_for_id(loop_id),
        "engine": engine,
        "statuses": statuses,
        "stage_catalog": stage_catalog,
    }
    if metrics is not None:
        out["metrics"] = metrics
    return out


def _builtin_public(meta: Dict[str, Any]) -> Dict[str, Any]:
    loop_id = meta["id"]
    engine = "simple"
    if loop_id in ("laundry",):
        engine = "laundry"
    elif loop_id in ("gym", "exercise"):
        engine = "gym"
    elif loop_id == "japa":
        engine = "japa"

    statuses: List[str] = []
    coach: Dict[str, Any] = {}
    if loop_id in LOOP_DEFS:
        defn = LOOP_DEFS[loop_id]
        statuses = list(defn["statuses"])
        coach = dict(defn["coach"])
    elif loop_id == "laundry":
        statuses = ["started", "washing", "dried", "folded", "put_away"]
    elif loop_id == "gym":
        statuses = ["decide", "leave", "arrive", "work", "log"]
    elif loop_id == "japa":
        statuses = ["sit", "practice", "log", "reflect", "done"]

    colors = {
        "laundry": "#4a9fd4",
        "sleep": "#6a9eae",
        "gym": "#d4844a",
        "japa": "#c9a227",
        "walk": "#7a9e6a",
        "autoresearch": "#5bb89a",
    }
    return template_public(
        loop_id=loop_id,
        name=meta.get("name") or loop_id.title(),
        description=meta.get("description") or "",
        default_query=meta.get("default_query") or "",
        guided=bool(meta.get("guided", True)),
        tags=list(meta.get("tags") or []),
        custom=False,
        color=colors.get(loop_id),
        engine=engine,
        statuses=statuses,
        coach=coach,
        metrics=list(meta.get("metrics") or []),
    )


async def list_custom_rows() -> List[LoopTemplate]:
    async with async_session() as session:
        result = await session.execute(
            select(LoopTemplate).order_by(LoopTemplate.created_at.asc())
        )
        return list(result.scalars().all())


async def get_custom_row(loop_id: str) -> Optional[LoopTemplate]:
    async with async_session() as session:
        result = await session.execute(
            select(LoopTemplate).where(LoopTemplate.id == loop_id)
        )
        return result.scalar_one_or_none()


async def list_all_templates() -> List[Dict[str, Any]]:
    out = [_builtin_public(dict(m)) for m in PERSONAL_LOOPS]
    for row in await list_custom_rows():
        defn = defn_from_row(row)
        out.append(
            template_public(
                loop_id=row.id,
                name=row.name,
                description=row.description or "",
                default_query=row.default_query or "",
                guided=True,
                tags=_loads(row.tags_json, []) or [row.id],
                custom=True,
                color=row.color or color_for_id(row.id),
                engine="simple",
                statuses=defn["statuses"],
                coach=defn["coach"],
            )
        )
    return out


async def get_template(loop_id: str) -> Optional[Dict[str, Any]]:
    meta = get_builtin_meta(loop_id)
    if meta:
        return _builtin_public(meta)
    row = await get_custom_row(loop_id)
    if not row:
        return None
    defn = defn_from_row(row)
    return template_public(
        loop_id=row.id,
        name=row.name,
        description=row.description or "",
        default_query=row.default_query or "",
        guided=True,
        tags=_loads(row.tags_json, []) or [row.id],
        custom=True,
        color=row.color or color_for_id(row.id),
        engine="simple",
        statuses=defn["statuses"],
        coach=defn["coach"],
    )


async def resolve_defn(loop_id: str) -> Optional[Dict[str, Any]]:
    """Engine definition for guided_simple (builtin LOOP_DEFS or custom DB)."""
    if loop_id in LOOP_DEFS:
        return dict(LOOP_DEFS[loop_id])
    row = await get_custom_row(loop_id)
    if not row:
        return None
    return defn_from_row(row)


async def create_custom_template(
    *,
    name: str,
    stages: List[str],
    description: str = "",
    default_query: str = "",
    color: Optional[str] = None,
    slug: Optional[str] = None,
) -> Dict[str, Any]:
    name = (name or "").strip()
    if not name:
        raise ValueError("Name is required")
    labels = normalize_stage_labels(stages)
    statuses = statuses_from_labels(labels)
    # Rebuild coach using original labels keyed by status id
    label_by_status = {statuses[i]: labels[i] for i in range(len(statuses))}
    coach = coach_from_labels([label_by_status[s] for s in statuses])

    loop_id = slugify(slug or name)
    if loop_id in RESERVED_IDS or loop_id in {m["id"] for m in PERSONAL_LOOPS}:
        raise ValueError(f"Slug '{loop_id}' is reserved")
    existing = await get_custom_row(loop_id)
    if existing:
        # uniquify
        base = loop_id
        for i in range(2, 50):
            cand = f"{base}_{i}"
            if not await get_custom_row(cand):
                loop_id = cand
                break
        else:
            loop_id = f"{base}_{uuid.uuid4().hex[:6]}"

    tags = [loop_id]
    row = LoopTemplate(
        id=loop_id,
        name=name,
        description=(description or "").strip()
        or f"Custom loop: {' → '.join(labels)}",
        default_query=(default_query or "").strip() or f"Start {name}.",
        color=color or color_for_id(loop_id),
        tags_json=_dumps(tags),
        statuses_json=_dumps(statuses),
        coach_json=_dumps(coach),
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    async with async_session() as session:
        session.add(row)
        await session.commit()

    return await get_template(loop_id)  # type: ignore[return-value]


async def delete_custom_template(loop_id: str) -> bool:
    if loop_id in RESERVED_IDS or get_builtin_meta(loop_id):
        raise ValueError("Cannot delete a builtin loop")
    async with async_session() as session:
        result = await session.execute(
            select(LoopTemplate).where(LoopTemplate.id == loop_id)
        )
        row = result.scalar_one_or_none()
        if not row:
            return False
        await session.delete(row)
        await session.commit()
        return True
