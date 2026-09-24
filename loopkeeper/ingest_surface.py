"""
Surfacing: ingest captures -> semantic clusters -> suggested missions.

The 'surfaced birth' of a mission. Reads the ingest store (markdown captures
with frontmatter), embeds and clusters them semantically, ranks the clusters
by signal (recurrence + recency + source mix), and asks one LLM call to frame
the top clusters into missions. Evidence (which captures surfaced it) is
attached deterministically, never invented by the model.

Pure read: writes no memory. Config is env-driven so nothing personal is
baked into code:
  INGEST_PATH / INGEST_DIR   dir of *.md captures (same folder the hub writes).
                             Unset -> empty (no personal default).
  SURFACE_WINDOW_DAYS     recency window (default 60)
  SURFACE_MAX_CAPTURES    cap embedded per run (default 250, most-recent first)
  SURFACE_LIMIT           missions returned (default 5)
  SURFACE_THRESHOLD       cosine merge threshold (default 0.66)
  EMBED_CACHE_PATH        json disk cache for embeddings
"""
from __future__ import annotations

import glob
import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


def ingest_dir() -> str:
    """Markdown capture folder. INGEST_PATH wins, then INGEST_DIR, then the
    hub default if that directory already exists."""
    for key in ("INGEST_PATH", "INGEST_DIR"):
        p = (os.getenv(key) or "").strip()
        if p:
            return os.path.expanduser(p)
    return ""


DEFAULT_SOURCES = ["voice", "braindump", "review", "email", "imessage", "apple-notes"]
_NOISE_TITLES = re.compile(
    r"^\s*(new note|untitled|daily|to do|todo|jul|aug|sep|oct|nov|dec|jan|feb|mar|apr|may|jun)\b"
    r"|^\s*\d{1,2}[:.]\d{2}\s*$|^\s*[a-z]{3}\s+at\s+(am|pm)\s*$",
    re.I,
)
# transactional notifications are not intents — receipts, shipping, greetings.
# These should never be promoted into a mission ("reorganize your bathroom").
_TRANSACTIONAL = re.compile(
    r"\b(shipped|delivered|out for delivery|arriving|has shipped|your order|order(ed)?|"
    r"order confirmation|tracking|returned?|refund|receipt|invoice|payment|"
    r"statement|renew(s|ed|al)?|subscription|verify your|confirm your|"
    r"sign[- ]?in|password|otp|one[- ]time code)\b",
    re.I,
)
_GREETING = re.compile(
    r"\b(casual )?greeting\b|^\s*(hi|hey|hello|yo|sup|good (morning|afternoon|evening|night))\b[\s!.]*$",
    re.I,
)
_IMG_LINE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_CURSOR_COORD = re.compile(r"\d+,\d+\s*→")


# ---- capture model -------------------------------------------------------

class Capture:
    __slots__ = ("id", "source", "title", "created", "text")

    def __init__(self, id: str, source: str, title: str, created: Optional[datetime], text: str):
        self.id = id
        self.source = source
        self.title = title
        self.created = created
        self.text = text

    def embed_text(self) -> str:
        return (self.title + "\n" + self.text).strip()[:900]


def _parse_frontmatter(raw: str) -> Tuple[Dict[str, str], str]:
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", raw, re.S)
    if not m:
        return {}, raw
    fm: Dict[str, str] = {}
    for line in m.group(1).splitlines():
        k, _, v = line.partition(":")
        if k.strip():
            fm[k.strip()] = v.strip().strip('"')
    return fm, m.group(2)


def _parse_created(s: str) -> Optional[datetime]:
    if not s:
        return None
    s = s.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        try:
            return datetime.fromisoformat(s[:10]).replace(tzinfo=timezone.utc)
        except ValueError:
            return None


def _clean_body(body: str) -> str:
    lines = []
    for ln in body.splitlines():
        if _IMG_LINE.search(ln) or _CURSOR_COORD.search(ln):
            continue
        if ln.strip() in ("---", "### Raw capture"):
            continue
        lines.append(ln)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def read_ingest(
    path: str,
    sources: List[str],
    window_days: int,
    max_captures: int,
) -> List[Capture]:
    """Parse, filter (source + recency), de-noise, cap to most-recent."""
    if not path or not os.path.isdir(path):
        return []
    cutoff = datetime.now(timezone.utc) - timedelta(days=window_days)
    allow = set(sources)
    out: List[Capture] = []
    for fp in glob.glob(os.path.join(path, "*.md")):
        try:
            raw = open(fp, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        fm, body = _parse_frontmatter(raw)
        source = fm.get("source", "")
        if source not in allow:
            continue
        created = _parse_created(fm.get("created", ""))
        if created and created < cutoff:
            continue
        title = fm.get("title", "").strip()
        text = _clean_body(body)
        blob = (title + " " + text).strip()
        # de-noise: junk-titled or near-empty apple-notes add nothing to surface
        if source == "apple-notes":
            if _NOISE_TITLES.search(title) or len(blob) < 45:
                continue
        # not intents: order/shipping/receipt notifications, bare greetings
        if source in ("email", "imessage") and _TRANSACTIONAL.search(blob):
            continue
        if _GREETING.search(title):
            continue
        if not (title or text):
            continue
        out.append(Capture(fm.get("id", os.path.basename(fp)), source, title or "(untitled)", created, text))
    out.sort(key=lambda c: c.created or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return out[:max_captures]


# ---- embeddings (batched + disk cache) -----------------------------------

def _cache_path() -> str:
    return os.getenv("EMBED_CACHE_PATH") or os.path.join(
        os.path.expanduser("~/.cache"), "valinor-embed-cache.json"
    )


def _load_cache() -> Dict[str, List[float]]:
    try:
        with open(_cache_path(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _save_cache(cache: Dict[str, List[float]]) -> None:
    p = _cache_path()
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(cache, f)
    except OSError as e:
        logger.warning(f"embed cache write failed: {e}")


def embed_captures(caps: List[Capture]) -> Dict[str, List[float]]:
    """Embed every capture's text, batched, cached by content hash on disk."""
    from embeddings import EMBEDDING_MODEL, _get_client, content_hash

    cache = _load_cache()
    texts = {c.id: c.embed_text() for c in caps}
    hashes = {cid: content_hash(t) for cid, t in texts.items()}
    missing = [(cid, texts[cid]) for cid, h in hashes.items() if h not in cache]

    client = _get_client()
    for i in range(0, len(missing), 128):
        chunk = missing[i:i + 128]
        resp = client.embeddings.create(model=EMBEDDING_MODEL, input=[t for _, t in chunk])
        for (cid, _), item in zip(chunk, resp.data):
            cache[hashes[cid]] = list(item.embedding)
    if missing:
        _save_cache(cache)
    return {cid: cache[h] for cid, h in hashes.items() if h in cache}


# ---- rejections (the learning loop) --------------------------------------
# A rejection is pinned to the capture ids behind the suggestion. Framed titles
# change every rescan, so title-similarity alone lets the same notes come back
# under a new label. Ids are the hard stop; title and centroid similarity cover
# older rejects that were stored before ids were kept.

def _rej_path() -> str:
    return os.getenv("REJECTIONS_PATH") or os.path.join(
        os.path.expanduser("~/.cache"), "valinor-rejections.json"
    )


def _load_rejections() -> List[Dict[str, Any]]:
    try:
        with open(_rej_path(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return []


def _norm_label(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _labels_match(a: str, b: str) -> bool:
    """Same suggestion even when the framer rewords it."""
    na, nb = _norm_label(a), _norm_label(b)
    if len(na) < 8 or len(nb) < 8:
        return False
    if na == nb:
        return True
    return len(na) >= 12 and len(nb) >= 12 and (na in nb or nb in na)


def _mission_keys(m: Dict[str, Any]) -> List[str]:
    keys = [k for k in (m.get("keys") or []) if k]
    for s in m.get("signals") or []:
        if isinstance(s, dict) and s.get("id") and s["id"] not in keys:
            keys.append(s["id"])
    return keys


def _cosine(a: List[float], b: List[float]) -> float:
    if not a or not b:
        return 0.0
    try:
        import numpy as np
        x = np.asarray(a, dtype=float)
        y = np.asarray(b, dtype=float)
        nx, ny = np.linalg.norm(x), np.linalg.norm(y)
        if nx == 0 or ny == 0:
            return 0.0
        return float(np.dot(x, y) / (nx * ny))
    except Exception:
        return 0.0


def _rejection_index(rejections: List[Dict[str, Any]]) -> Dict[str, Any]:
    keys = set()
    for r in rejections:
        for k in r.get("keys") or []:
            if k:
                keys.add(k)
    return {
        "keys": keys,
        "rows": rejections,
        "title_th": float(os.getenv("REJECT_SUPPRESS_THRESHOLD", "0.72")),
        "cluster_th": float(os.getenv("REJECT_CLUSTER_THRESHOLD", "0.64")),
    }


def _keys_for_rejection(title: str, theme: str, keys: Optional[List[str]], vec: List[float]) -> List[str]:
    """Capture ids that produced this suggestion. Prefer what the client sent;
    otherwise pull them off the cached mission so a later rephrase can't sneak back."""
    found = [k for k in (keys or []) if k]
    if found:
        return found
    cache = _load_json(_cache_file("SURFACE_CACHE_PATH", "valinor-missions.json"), {})
    best: List[str] = []
    best_sim = 0.0
    for m in cache.get("missions") or []:
        ids = _mission_keys(m)
        if not ids:
            continue
        if _label_hit(title, theme, m):
            return ids
        sim = _cosine(vec, m.get("vec") or [])
        if sim > best_sim:
            best_sim, best = sim, ids
    th = float(os.getenv("REJECT_CLUSTER_THRESHOLD", "0.64"))
    return best if best_sim >= th else []


def record_rejection(title: str, theme: str, why: str = "", keys: Optional[List[str]] = None) -> Dict[str, Any]:
    """Store a rejected suggestion. Capture ids are the stable id — framed
    titles change every rescan, so title-similarity alone lets the same notes
    come back under a new label."""
    from embeddings import embed

    vec: List[float] = []
    try:
        vec = embed((title or theme).strip())
    except Exception as e:  # embedding down — keep the reason, skip the vector
        logger.warning(f"reject embed failed: {e}")
    bound = _keys_for_rejection(title, theme, keys, vec)
    rej = _load_rejections()
    rej.append({
        "title": title, "theme": theme, "why": (why or "").strip(),
        "keys": bound,
        "ts": datetime.now(timezone.utc).isoformat(), "vec": vec,
    })
    rej = rej[-200:]
    _save_rejections(rej)
    try:
        from muse import mark_status
        mark_status(title=title, status="rejected", why=why)
    except Exception:
        pass
    return {"stored": len(rej), "keys": len(bound)}


def _save_rejections(rej: List[Dict[str, Any]]) -> None:
    p = _rej_path()
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(rej, f)
    except OSError as e:
        logger.warning(f"reject store write failed: {e}")


def _suppressed(theme: str, rej_vecs, threshold: float) -> bool:
    if not rej_vecs:
        return False
    try:
        from embeddings import embed
        import numpy as np
        v = np.asarray(embed(theme), dtype=float)
        n = np.linalg.norm(v)
        if n == 0:
            return False
        v = v / n
        return any(float(np.dot(rv, v)) >= threshold for rv in rej_vecs)
    except Exception:
        return False


# ---- clustering ----------------------------------------------------------

def _cluster(caps: List[Capture], vecs: Dict[str, List[float]], threshold: float) -> List[List[Capture]]:
    """Greedy cosine clustering. Vectors are near-unit-norm (OpenAI), so we
    normalize and compare against running centroids."""
    import numpy as np

    clusters: List[Dict[str, Any]] = []  # {centroid, members}
    for c in caps:
        v = vecs.get(c.id)
        if not v:
            continue
        x = np.asarray(v, dtype=float)
        n = np.linalg.norm(x)
        if n == 0:
            continue
        x = x / n
        best, best_sim = None, threshold
        for cl in clusters:
            sim = float(np.dot(cl["centroid"], x))
            if sim >= best_sim:
                best, best_sim = cl, sim
        if best is None:
            clusters.append({"centroid": x, "members": [c]})
        else:
            m = best["members"]
            m.append(c)
            best["centroid"] = (best["centroid"] * (len(m) - 1) + x) / len(m)
    return [cl["members"] for cl in clusters]


def _score(members: List[Capture]) -> float:
    now = datetime.now(timezone.utc)
    dates = [m.created for m in members if m.created]
    recent = min((now - max(dates)).days, 365) if dates else 365
    recency = max(0.0, 1.0 - recent / 60.0)              # 0..1, fresh = high
    recurrence = min(len(members), 6) / 6.0              # 0..1
    diversity = min(len({m.source for m in members}), 3) / 3.0
    intent_bonus = 0.25 if any(m.source in ("voice", "braindump", "review") for m in members) else 0.0
    return 1.6 * recurrence + 1.2 * recency + 0.4 * diversity + intent_bonus


def _evidence(members: List[Capture]) -> List[Dict[str, str]]:
    ev = []
    for m in sorted(members, key=lambda c: c.created or datetime.min.replace(tzinfo=timezone.utc), reverse=True):
        ev.append({
            "id": m.id,
            "source": m.source,
            "title": m.title,
            "date": m.created.date().isoformat() if m.created else "",
        })
    return ev


def _icon(members: List[Capture]) -> str:
    blob = " ".join((m.title + " " + m.text) for m in members).lower()
    # specific first: exact activity beats generic topic
    for kw, ico in (
        ("wedding", "ring"), ("proposal", "ring"), ("interview", "briefcase"), ("resume", "file"),
        ("deck", "chart"), ("deploy", "rocket"), ("ship", "rocket"), ("bug", "wrench"),
        ("valinor", "code"), ("code", "code"), ("cursor", "code"), ("repo", "code"),
        ("trip", "rocket"), ("flight", "rocket"), ("hotel", "building"), ("dinner", "spark"),
        ("party", "spark"), ("gift", "bag"), ("bill", "card"), ("rent", "card"),
        ("tax", "file"), ("invoice", "file"), ("doctor", "heart"), ("dentist", "heart"),
        ("gym", "zap"), ("run", "zap"), ("walk", "zap"), ("sleep", "moon"),
        ("car", "map"), ("repair", "wrench"), ("clean", "spark"), ("organize", "spark"),
        ("shop", "bag"), ("buy", "bag"), ("book", "book"), ("read", "book"),
        ("course", "book"), ("learn", "book"), ("music", "music"), ("photo", "camera"),
        ("dog", "heart"), ("cat", "heart"), ("garden", "leaf"), ("call", "phone"),
        ("meeting", "phone"), ("email", "mail"), ("tweet", "chat"), ("write", "pen"),
        ("essay", "pen"), ("plan", "map"), ("idea", "idea"), ("job", "briefcase"),
        ("mom", "users"), ("dad", "users"), ("family", "users"), ("friend", "users"),
    ):
        if kw in blob:
            return ico
    src = members[0].source
    return {"voice": "mic", "review": "refresh", "email": "mail", "imessage": "chat",
            "apple-notes": "notes", "braindump": "brain"}.get(src, "zap")


# ---- LLM framing ---------------------------------------------------------

class FramedMission(BaseModel):
    cluster: int = Field(description="index of the cluster this frames")
    title: str = Field(max_length=70, description="short human label")
    outcome: str = Field(description="what you'll have when done, one line, no 'you will'")
    theme: str = Field(description="imperative instruction for the task planner")
    comment: str = Field(default="", description="scope/constraints for the planner")


class FramedBatch(BaseModel):
    missions: List[FramedMission]


FRAME_SYSTEM = (
    "You turn clusters of a person's own captured notes into candidate missions. "
    "Each cluster is a set of related captures (voice notes, reviews, emails, texts, "
    "notes) about one thing they keep circling. For each cluster, write one mission. "
    "Respond with ONLY valid JSON matching the schema.\n\n"
    "Rules:\n"
    "- title: short, concrete, human — what the thing IS, not how it was captured.\n"
    "- outcome: one line naming the finished first version, e.g. 'a first version of "
    "the guest list — names only'. No 'you will', no fluff.\n"
    "- theme: an imperative the planner can break down, e.g. 'Get the wedding guest "
    "list started'.\n"
    "- comment: any scope limit the notes imply (what's explicitly not now).\n"
    "- Never invent facts not in the captures. One mission per cluster index given."
)


def _frame_llm(clusters: List[List[Capture]], avoid_notes: Optional[List[str]] = None) -> FramedBatch:
    from openrouter_client import OpenRouterClient

    blocks = []
    for i, members in enumerate(clusters):
        lines = [f"CLUSTER {i} ({len(members)} captures):"]
        for m in members[:6]:
            snippet = (m.text or "").replace("\n", " ")[:160]
            lines.append(f"  - [{m.source}] {m.title} :: {snippet}")
        blocks.append("\n".join(lines))
    prompt = "Frame one mission per cluster.\n\n" + "\n\n".join(blocks)
    if avoid_notes:
        prompt += (
            "\n\nThe user has REJECTED suggestions like these before — do not "
            "resurface anything similar:\n" + "\n".join("  - " + n for n in avoid_notes)
        )
    model = os.getenv("SURFACE_MODEL", os.getenv("PLANNER_MODEL", "openai/gpt-4o-mini"))
    client = OpenRouterClient()
    return client.generate_structured(prompt, FramedBatch, system=FRAME_SYSTEM, model=model, temperature=0.4)


def _frame_fallback(clusters: List[List[Capture]]) -> FramedBatch:
    missions = []
    for i, members in enumerate(clusters):
        newest = max(members, key=lambda c: c.created or datetime.min.replace(tzinfo=timezone.utc))
        title = newest.title[:70]
        missions.append(FramedMission(
            cluster=i, title=title,
            outcome=f"a first version of {title.lower()}",
            theme=f"Make progress on: {title}", comment="",
        ))
    return FramedBatch(missions=missions)


def _why_now(members: List[Capture]) -> str:
    dates = sorted([m.created for m in members if m.created])
    n = len(members)
    srcs = {m.source for m in members}
    bits = []
    if n > 1:
        span = f"{dates[0].date().isoformat()}" if dates else ""
        bits.append(f"came up {n}× since {span}" if span else f"came up {n}×")
    if "review" in srcs:
        bits.append("a review is still open")
    if dates:
        days = (datetime.now(timezone.utc) - dates[-1]).days
        bits.append("touched today" if days == 0 else f"last touched {days}d ago")
    return "; ".join(bits) or "recent capture"


# ---- mission cache + consumed (store missions, skip the LLM next time) ---
# Framing is the costly step (embeddings + one structured LLM call). We cache
# a POOL of framed missions fingerprinted to the ingest dir; a page load just
# reads + filters (rejections/consumed) with pure vector math — no LLM. We
# regenerate only when the ingest changes, the TTL expires, or refresh=1.

def _cache_file(env: str, name: str) -> str:
    return os.getenv(env) or os.path.join(os.path.expanduser("~/.cache"), name)


def _load_json(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def _save_json(path: str, data) -> None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except OSError as e:
        logger.warning(f"cache write failed ({path}): {e}")


def _load_consumed() -> List[str]:
    return _load_json(_cache_file("CONSUMED_PATH", "valinor-consumed.json"), {}).get("titles", [])


def record_consumed(title: str) -> Dict[str, Any]:
    """Mark a mission accepted/handled so it stops being surfaced."""
    titles = _load_consumed()
    t = (title or "").strip()
    if t and t not in titles:
        titles.append(t)
    titles = titles[-300:]
    _save_json(_cache_file("CONSUMED_PATH", "valinor-consumed.json"), {"titles": titles})
    try:
        from muse import mark_status
        mark_status(title=t, status="consumed")
    except Exception:
        pass
    return {"consumed": len(titles)}


def _ingest_signature(path: str, sources: List[str], window_days: int, pool: int) -> str:
    files = glob.glob(os.path.join(path, "*.md"))
    latest = max((os.path.getmtime(f) for f in files), default=0)
    return f"{len(files)}:{int(latest)}:{','.join(sorted(sources))}:{window_days}:{pool}"


def _age_min(iso: Optional[str]) -> float:
    if not iso:
        return 1e9
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if not dt.tzinfo:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).total_seconds() / 60.0
    except ValueError:
        return 1e9


def _resolve(sources, window_days, limit):
    path = ingest_dir()
    sources = sources or (os.getenv("SURFACE_SOURCES", "").split(",") if os.getenv("SURFACE_SOURCES") else DEFAULT_SOURCES)
    sources = [s.strip() for s in sources if s.strip()]
    window_days = window_days or int(os.getenv("SURFACE_WINDOW_DAYS", "60"))
    limit = limit or int(os.getenv("SURFACE_LIMIT", "5"))
    pool = max(limit + 5, int(os.getenv("SURFACE_POOL", "10")))
    return path, sources, window_days, limit, pool


def _generate_batch(path: str, sources: List[str], window_days: int, pool: int) -> Dict[str, Any]:
    """The costly path: read -> embed -> cluster -> rank -> frame a pool.
    Stores a title embedding per mission so read-time reject-filtering is free."""
    max_caps = int(os.getenv("SURFACE_MAX_CAPTURES", "250"))
    threshold = float(os.getenv("SURFACE_THRESHOLD", "0.66"))
    caps = read_ingest(path, sources, window_days, max_caps)
    if not caps:
        return {"missions": [], "counts": {"captures": 0, "clusters": 0}, "fallback": False}

    vecs: Dict[str, List[float]] = {}
    fallback = False
    try:
        vecs = embed_captures(caps)
        clusters = _cluster(caps, vecs, threshold)
    except Exception as e:
        logger.warning(f"surface embed/cluster failed: {e}")
        clusters = [[c] for c in caps]
        fallback = True

    clusters.sort(key=_score, reverse=True)
    rejections = _load_rejections()
    idx = _rejection_index(rejections)
    top = []
    for members in clusters:
        if _cluster_blocked(members, vecs, idx):
            continue
        top.append(members)
        if len(top) >= pool:
            break

    avoid_notes = [(r.get("title", "") + (" — " + r["why"] if r.get("why") else "")).strip()
                   for r in rejections[-30:] if r.get("title")]
    try:
        if fallback:
            raise RuntimeError("skip llm framing in fallback")
        framed = _frame_llm(top, avoid_notes)
        by_idx = {m.cluster: m for m in framed.missions}
    except Exception as e:
        logger.warning(f"surface framing fallback: {e}")
        framed = _frame_fallback(top)
        by_idx = {m.cluster: m for m in framed.missions}
        fallback = True

    try:
        from embeddings import embed
    except Exception:
        embed = None
    missions = []
    for i, members in enumerate(top):
        fm = by_idx.get(i) or _frame_fallback([members]).missions[0]
        newest = max((m.created for m in members if m.created), default=None)
        vec: List[float] = []
        if embed:
            try:
                vec = embed(fm.title)
            except Exception:
                vec = []
        missions.append({
            "id": f"surf-{i}-{members[0].id[:12]}",
            "icon": _icon(members), "title": fm.title, "outcome": fm.outcome,
            "theme": fm.theme, "comment": fm.comment, "why_now": _why_now(members),
            "signals": _evidence(members), "cluster_size": len(members),
            "keys": [m.id for m in members],
            "last_seen": newest.date().isoformat() if newest else "", "vec": vec,
        })
    return {"missions": missions,
            "counts": {"captures": len(caps), "clusters": len(clusters)},
            "fallback": fallback}


def _cluster_blocked(members: List[Capture], vecs: Dict[str, List[float]], idx: Dict[str, Any]) -> bool:
    """True when this cluster is a rejected suggestion coming back.
    Shared capture id is exact. Centroid vs the rejected label catches a
    rescan that rephrased the title before ids were stored."""
    if {m.id for m in members} & idx["keys"]:
        return True
    if not vecs:
        return False
    try:
        import numpy as np
    except Exception:
        return False
    acc = None
    n = 0
    for m in members:
        v = vecs.get(m.id)
        if not v:
            continue
        x = np.asarray(v, dtype=float)
        acc = x if acc is None else acc + x
        n += 1
    if not n:
        return False
    centroid = (acc / n).tolist()
    return any(_cosine(centroid, r.get("vec") or []) >= idx["cluster_th"] for r in idx["rows"])


def _label_hit(title: str, theme: str, r: Dict[str, Any]) -> bool:
    rt, rth = r.get("title") or "", r.get("theme") or ""
    return (_labels_match(title, rt) or _labels_match(theme, rth)
            or _labels_match(title, rth) or _labels_match(theme, rt))


def _mission_rejected(m: Dict[str, Any], idx: Dict[str, Any]) -> bool:
    if set(_mission_keys(m)) & idx["keys"]:
        return True
    title, theme = m.get("title") or "", m.get("theme") or ""
    for r in idx["rows"]:
        if _label_hit(title, theme, r):
            return True
        if _cosine(m.get("vec") or [], r.get("vec") or []) >= idx["title_th"]:
            return True
    return False


def _stamp_rejection_keys(m: Dict[str, Any], rejections: List[Dict[str, Any]], idx: Dict[str, Any]) -> bool:
    """Older rejects stored a title only. Once we can see which captures they
    came from, pin those ids so the next rescan drops the cluster outright."""
    ids = _mission_keys(m)
    if not ids:
        return False
    changed = False
    title, theme = m.get("title") or "", m.get("theme") or ""
    for r in rejections:
        if r.get("keys"):
            continue
        hit = _label_hit(title, theme, r) or _cosine(m.get("vec") or [], r.get("vec") or []) >= idx["title_th"]
        if hit:
            r["keys"] = ids
            changed = True
    return changed


def _filter_missions(missions: List[Dict[str, Any]], limit: int) -> List[Dict[str, Any]]:
    """Drop consumed + rejected (by capture id, label, or title similarity).
    Strips internal vectors. Caps to limit."""
    raw_consumed = set(_load_consumed())
    consumed = {_norm_label(t) for t in raw_consumed}
    rejections = _load_rejections()
    idx = _rejection_index(rejections)
    stamped = False
    out = []
    for m in missions:
        title = m.get("title", "")
        if title in raw_consumed or _norm_label(title) in consumed:
            continue
        if _mission_rejected(m, idx):
            if _stamp_rejection_keys(m, rejections, idx):
                stamped = True
                idx = _rejection_index(rejections)
            continue
        out.append({k: v for k, v in m.items() if k != "vec"})
    if stamped:
        _save_rejections(rejections)
    return out[:limit]


# ---- public entry --------------------------------------------------------

def surface_missions(sources=None, window_days=None, limit=None, force=False) -> Dict[str, Any]:
    """Cached read. Returns suggested missions + evidence. Regenerates (the
    costly LLM path) only on ingest change, TTL expiry, or force. Never raises.
    Muse missions (already framed) always merge in front, even with no ingest."""
    path, sources, window_days, limit, pool = _resolve(sources, window_days, limit)
    ingest: List[Dict[str, Any]] = []
    counts = {"captures": 0, "clusters": 0}
    fallback = False
    cached = False
    generated_at = None
    configured = bool(path and os.path.isdir(path))

    # Muse is already framed. Return it even when ingest regen would block.
    try:
        from muse import surfaced_missions as muse_surfaced
        muse = muse_surfaced()
    except Exception:
        muse = []

    if configured:
        cache_path = _cache_file("SURFACE_CACHE_PATH", "valinor-missions.json")
        cache = _load_json(cache_path, {})
        if force:
            sig = _ingest_signature(path, sources, window_days, pool)
            batch = _generate_batch(path, sources, window_days, pool)
            batch["signature"] = sig
            batch["generated_at"] = datetime.now(timezone.utc).isoformat()
            _save_json(cache_path, batch)
        elif cache.get("missions") is not None:
            batch = cache
            cached = True
        else:
            batch = None
        if batch is not None:
            ingest = _filter_missions(batch.get("missions", []), limit)
            counts = batch.get("counts", counts)
            fallback = batch.get("fallback", False)
            generated_at = batch.get("generated_at")

    return {"missions": muse + ingest,
            "counts": counts, "sources": sources, "window_days": window_days,
            "fallback": fallback, "configured": configured,
            "cached": cached, "generated_at": generated_at, "muse": len(muse)}


def sources_summary(window_days=None) -> Dict[str, Any]:
    """What ingest is pulling from (counts + last-seen per source) + the
    connectors you could add. Powers the settings/sources view."""
    path = ingest_dir()
    enabled = set(_resolve(None, None, None)[1])
    window_days = window_days or int(os.getenv("SURFACE_WINDOW_DAYS", "60"))
    labels = {
        "voice": ("Voice notes", "mic"), "braindump": ("Brain dumps", "brain"),
        "review": ("Reviews", "refresh"), "email": ("Email", "mail"), "imessage": ("iMessage", "chat"),
        "apple-notes": ("Apple Notes", "notes"), "conversation": ("Conversations", "users"),
        "cursor": ("Cursor activity", "pointer"), "screenshot": ("Screenshots", "image"),
        "photos": ("Photos", "camera"),
    }
    counts: Dict[str, int] = {}
    last: Dict[str, datetime] = {}
    if path and os.path.isdir(path):
        for fp in glob.glob(os.path.join(path, "*.md")):
            try:
                raw = open(fp, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            fm, _ = _parse_frontmatter(raw)
            s = fm.get("source", "") or "other"
            counts[s] = counts.get(s, 0) + 1
            d = _parse_created(fm.get("created", ""))
            if d and (s not in last or d > last[s]):
                last[s] = d
    sources = []
    for s in sorted(counts, key=lambda k: -counts[k]):
        lab, ico = labels.get(s, (s.replace("-", " ").title(), "zap"))
        sources.append({"id": s, "label": lab, "icon": ico, "count": counts[s],
                        "last_seen": last[s].date().isoformat() if s in last else "",
                        "enabled": s in enabled, "connected": True})
    try:
        from muse import connector_status as muse_status
        muse_st = muse_status()
    except Exception:
        muse_st = "planned"
    connectors = [
        {"id": "muse", "label": "Muse", "icon": "muse", "status": muse_st,
         "desc": "Muse pushes missions here, then polls Valinor for closes."},
        {"id": "google", "label": "Google", "icon": "google", "status": "planned",
         "desc": "Calendar events + Gmail threads surface prep and follow-up missions."},
        {"id": "claude-code", "label": "Claude Code", "icon": "claude", "status": "planned",
         "desc": "Hand code-sized steps to Claude Code; proofs flow back into the loop."},
        {"id": "codex", "label": "Codex", "icon": "code", "status": "planned",
         "desc": "Delegate research and draft steps to Codex with the loop's context attached."},
        {"id": "linear", "label": "Linear", "icon": "linear", "status": "planned",
         "desc": "Turn assigned issues into proof-gated loops."},
    ]
    return {"sources": sources, "connectors_available": connectors,
            "window_days": window_days, "configured": bool(path), "total": sum(counts.values())}
