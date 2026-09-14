"""
Idempotent note primitives + hybrid (keyword + vector) discovery.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

import numpy as np
from sqlalchemy import or_, select

from database import Note, NoteLink, async_session
from embeddings import content_hash, embed

logger = logging.getLogger(__name__)


def _parse_json(value: Optional[str], default: Any) -> Any:
    if value is None:
        return default
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return default


def note_to_dict(note: Note) -> Dict[str, Any]:
    return {
        "id": note.id,
        "title": note.title,
        "body": note.body,
        "tags": _parse_json(note.tags, []),
        "content_hash": note.content_hash,
        "created_at": note.created_at.isoformat() if note.created_at else None,
        "updated_at": note.updated_at.isoformat() if note.updated_at else None,
    }


def _cosine(a: List[float], b: List[float]) -> float:
    if not a or not b:
        return 0.0
    va = np.asarray(a, dtype=np.float64)
    vb = np.asarray(b, dtype=np.float64)
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
    if denom == 0.0:
        return 0.0
    return float(np.dot(va, vb) / denom)


async def createNote(
    title: str,
    body: str,
    tags: Optional[List[str]] = None,
    note_id: Optional[str] = None,
    *,
    compute_embedding: bool = True,
) -> Dict[str, Any]:
    """Create a note. Idempotent by content_hash when an identical note already exists."""
    tags = tags or []
    hash_key = content_hash(f"{title}\n{body}\n{json.dumps(sorted(tags))}")

    async with async_session() as session:
        existing = await session.execute(
            select(Note).where(Note.content_hash == hash_key).limit(1)
        )
        found = existing.scalar_one_or_none()
        if found:
            return note_to_dict(found)

        if note_id:
            by_id = await session.execute(select(Note).where(Note.id == note_id))
            existing_by_id = by_id.scalar_one_or_none()
            if existing_by_id:
                return note_to_dict(existing_by_id)

        nid = note_id or str(uuid.uuid4())
        embedding_json = None
        if compute_embedding:
            try:
                vec = embed(f"{title}\n{body}")
                embedding_json = json.dumps(vec) if vec else None
            except Exception as e:
                logger.warning(f"Embedding failed for new note: {e}")

        note = Note(
            id=nid,
            title=title,
            body=body,
            tags=json.dumps(tags),
            embedding=embedding_json,
            content_hash=hash_key,
        )
        session.add(note)
        await session.commit()
        await session.refresh(note)
        return note_to_dict(note)


async def updateNote(
    note_id: str,
    *,
    title: Optional[str] = None,
    body: Optional[str] = None,
    tags: Optional[List[str]] = None,
    compute_embedding: bool = True,
) -> Dict[str, Any]:
    """Update a note. Idempotent when content is unchanged."""
    async with async_session() as session:
        result = await session.execute(select(Note).where(Note.id == note_id))
        note = result.scalar_one_or_none()
        if not note:
            raise ValueError(f"Note not found: {note_id}")

        new_title = title if title is not None else note.title
        new_body = body if body is not None else note.body
        new_tags = tags if tags is not None else _parse_json(note.tags, [])
        hash_key = content_hash(f"{new_title}\n{new_body}\n{json.dumps(sorted(new_tags))}")

        if note.content_hash == hash_key:
            return note_to_dict(note)

        note.title = new_title
        note.body = new_body
        note.tags = json.dumps(new_tags)
        note.content_hash = hash_key
        note.updated_at = datetime.utcnow()

        if compute_embedding:
            try:
                vec = embed(f"{new_title}\n{new_body}")
                note.embedding = json.dumps(vec) if vec else note.embedding
            except Exception as e:
                logger.warning(f"Embedding failed for updateNote: {e}")

        await session.commit()
        await session.refresh(note)
        return note_to_dict(note)


async def linkNotes(src_note_id: str, dst_note_id: str, rel: str = "related") -> Dict[str, Any]:
    """Create a link between notes. Idempotent on (src, dst, rel)."""
    async with async_session() as session:
        for nid in (src_note_id, dst_note_id):
            exists = await session.execute(select(Note).where(Note.id == nid))
            if not exists.scalar_one_or_none():
                raise ValueError(f"Note not found: {nid}")

        existing = await session.execute(
            select(NoteLink).where(
                NoteLink.src_note_id == src_note_id,
                NoteLink.dst_note_id == dst_note_id,
                NoteLink.rel == rel,
            )
        )
        found = existing.scalar_one_or_none()
        if found:
            return {
                "id": found.id,
                "src_note_id": found.src_note_id,
                "dst_note_id": found.dst_note_id,
                "rel": found.rel,
            }

        link = NoteLink(
            id=str(uuid.uuid4()),
            src_note_id=src_note_id,
            dst_note_id=dst_note_id,
            rel=rel,
        )
        session.add(link)
        await session.commit()
        return {
            "id": link.id,
            "src_note_id": link.src_note_id,
            "dst_note_id": link.dst_note_id,
            "rel": link.rel,
        }


async def tag(note_id: str, tags: List[str]) -> Dict[str, Any]:
    """Add tags to a note (union). Idempotent."""
    async with async_session() as session:
        result = await session.execute(select(Note).where(Note.id == note_id))
        note = result.scalar_one_or_none()
        if not note:
            raise ValueError(f"Note not found: {note_id}")

        current = set(_parse_json(note.tags, []))
        merged = sorted(current.union(tags))
        if merged == sorted(current):
            return note_to_dict(note)

        note.tags = json.dumps(merged)
        note.content_hash = content_hash(f"{note.title}\n{note.body}\n{json.dumps(merged)}")
        note.updated_at = datetime.utcnow()
        await session.commit()
        await session.refresh(note)
        return note_to_dict(note)


async def embed_note(note_id: str) -> Dict[str, Any]:
    """Compute and store embedding for a note. Idempotent by content_hash when already embedded."""
    async with async_session() as session:
        result = await session.execute(select(Note).where(Note.id == note_id))
        note = result.scalar_one_or_none()
        if not note:
            raise ValueError(f"Note not found: {note_id}")

        if note.embedding:
            return note_to_dict(note)

        vec = embed(f"{note.title}\n{note.body}")
        note.embedding = json.dumps(vec) if vec else None
        note.updated_at = datetime.utcnow()
        await session.commit()
        await session.refresh(note)
        return note_to_dict(note)


async def get_note(note_id: str) -> Optional[Dict[str, Any]]:
    async with async_session() as session:
        result = await session.execute(select(Note).where(Note.id == note_id))
        note = result.scalar_one_or_none()
        return note_to_dict(note) if note else None


async def note_exists(note_id: str) -> bool:
    async with async_session() as session:
        result = await session.execute(select(Note.id).where(Note.id == note_id))
        return result.scalar_one_or_none() is not None


async def discover(query: str, *, limit: int = 10) -> List[Dict[str, Any]]:
    """Hybrid retrieval: keyword LIKE + cosine similarity over stored embeddings."""
    query = (query or "").strip()
    if not query:
        return []

    tokens = [t for t in query.lower().split() if len(t) >= 2]
    query_vec: List[float] = []
    try:
        query_vec = embed(query)
    except Exception as e:
        logger.warning(f"Query embedding failed, keyword-only discover: {e}")

    async with async_session() as session:
        stmt = select(Note)
        if tokens:
            filters = []
            for t in tokens[:8]:
                like = f"%{t}%"
                filters.append(Note.title.ilike(like))
                filters.append(Note.body.ilike(like))
                filters.append(Note.tags.ilike(like))
            stmt = stmt.where(or_(*filters))
        result = await session.execute(stmt.limit(200))
        notes = list(result.scalars().all())

        # If keyword filter returned nothing, fall back to all notes for vector ranking
        if not notes and query_vec:
            result = await session.execute(select(Note).limit(200))
            notes = list(result.scalars().all())

        scored: List[tuple] = []
        for note in notes:
            keyword_score = 0.0
            blob = f"{note.title} {note.body} {note.tags}".lower()
            for t in tokens:
                if t in blob:
                    keyword_score += 1.0
            if tokens:
                keyword_score /= len(tokens)

            vector_score = 0.0
            if query_vec and note.embedding:
                note_vec = _parse_json(note.embedding, [])
                vector_score = _cosine(query_vec, note_vec)

            score = 0.45 * keyword_score + 0.55 * vector_score
            scored.append((score, note))

        scored.sort(key=lambda x: x[0], reverse=True)
        out = []
        for score, note in scored[:limit]:
            d = note_to_dict(note)
            d["score"] = round(score, 4)
            out.append(d)
        return out


async def apply_staged_diff(
    diff: Dict[str, Any],
    *,
    require_seal: bool = True,
) -> Dict[str, Any]:
    """
    Atomically apply a sealed staged diff.

    Safeguards:
    - Refuse unsealed / tampered artifacts (content_hash check)
    - Build rollback journal before mutation; restore on failure
    """
    from execute_safeguards import (
        build_rollback_journal,
        restore_rollback_journal,
        verify_seal,
    )

    if require_seal:
        seal_err = verify_seal(diff)
        if seal_err:
            raise ValueError(f"Commit refused: {seal_err}")

    ops = diff.get("ops") or []
    journal = await build_rollback_journal(ops)
    created_note_ids: List[str] = []
    results: List[Dict[str, Any]] = []

    async with async_session() as session:
        try:
            for op in ops:
                op_type = op.get("op")
                payload = op.get("payload") or {}
                result: Dict[str, Any]

                if op_type == "createNote":
                    title = payload.get("title") or ""
                    body = payload.get("body") or ""
                    tags = payload.get("tags") or []
                    note_id = payload.get("id")
                    hash_key = content_hash(f"{title}\n{body}\n{json.dumps(sorted(tags))}")
                    existing = await session.execute(
                        select(Note).where(Note.content_hash == hash_key).limit(1)
                    )
                    found = existing.scalar_one_or_none()
                    if found:
                        result = note_to_dict(found)
                    else:
                        if note_id:
                            by_id = await session.execute(select(Note).where(Note.id == note_id))
                            existing_by_id = by_id.scalar_one_or_none()
                            if existing_by_id:
                                result = note_to_dict(existing_by_id)
                            else:
                                note = Note(
                                    id=note_id,
                                    title=title,
                                    body=body,
                                    tags=json.dumps(tags),
                                    content_hash=hash_key,
                                )
                                session.add(note)
                                await session.flush()
                                created_note_ids.append(note.id)
                                result = note_to_dict(note)
                        else:
                            note = Note(
                                id=str(uuid.uuid4()),
                                title=title,
                                body=body,
                                tags=json.dumps(tags),
                                content_hash=hash_key,
                            )
                            session.add(note)
                            await session.flush()
                            created_note_ids.append(note.id)
                            result = note_to_dict(note)

                elif op_type == "updateNote":
                    note_id = payload["note_id"]
                    res = await session.execute(select(Note).where(Note.id == note_id))
                    note = res.scalar_one_or_none()
                    if not note:
                        raise ValueError(f"Note not found: {note_id}")
                    if "title" in payload:
                        note.title = payload["title"]
                    if "body" in payload:
                        note.body = payload["body"]
                    if "tags" in payload:
                        note.tags = json.dumps(payload["tags"])
                    tags = _parse_json(note.tags, [])
                    note.content_hash = content_hash(
                        f"{note.title}\n{note.body}\n{json.dumps(sorted(tags))}"
                    )
                    note.updated_at = datetime.utcnow()
                    await session.flush()
                    result = note_to_dict(note)

                elif op_type == "tag":
                    note_id = payload["note_id"]
                    res = await session.execute(select(Note).where(Note.id == note_id))
                    note = res.scalar_one_or_none()
                    if not note:
                        raise ValueError(f"Note not found: {note_id}")
                    current = set(_parse_json(note.tags, []))
                    merged = sorted(current.union(payload.get("tags") or []))
                    note.tags = json.dumps(merged)
                    note.content_hash = content_hash(
                        f"{note.title}\n{note.body}\n{json.dumps(merged)}"
                    )
                    note.updated_at = datetime.utcnow()
                    await session.flush()
                    result = note_to_dict(note)

                elif op_type == "linkNotes":
                    src = payload["src_note_id"]
                    dst = payload["dst_note_id"]
                    rel = payload.get("rel") or "related"
                    existing = await session.execute(
                        select(NoteLink).where(
                            NoteLink.src_note_id == src,
                            NoteLink.dst_note_id == dst,
                            NoteLink.rel == rel,
                        )
                    )
                    found = existing.scalar_one_or_none()
                    if found:
                        result = {
                            "id": found.id,
                            "src_note_id": found.src_note_id,
                            "dst_note_id": found.dst_note_id,
                            "rel": found.rel,
                        }
                    else:
                        link = NoteLink(
                            id=str(uuid.uuid4()),
                            src_note_id=src,
                            dst_note_id=dst,
                            rel=rel,
                        )
                        session.add(link)
                        await session.flush()
                        result = {
                            "id": link.id,
                            "src_note_id": src,
                            "dst_note_id": dst,
                            "rel": rel,
                        }

                elif op_type == "embed":
                    note_id = payload["note_id"]
                    res = await session.execute(select(Note).where(Note.id == note_id))
                    note = res.scalar_one_or_none()
                    if not note:
                        raise ValueError(f"Note not found: {note_id}")
                    if not note.embedding:
                        try:
                            vec = embed(f"{note.title}\n{note.body}")
                            note.embedding = json.dumps(vec) if vec else None
                            note.updated_at = datetime.utcnow()
                            await session.flush()
                        except Exception as e:
                            logger.warning(f"embed op failed: {e}")
                    result = note_to_dict(note)

                else:
                    raise ValueError(f"Unknown staged op: {op_type}")

                results.append({"op": op_type, "result": result})

            await session.commit()
            journal["created_note_ids"] = created_note_ids
            return {
                "commit_results": results,
                "rollback_journal": journal,
                "rolled_back": False,
                "content_hash": diff.get("content_hash"),
            }
        except Exception as e:
            await session.rollback()
            journal["created_note_ids"] = created_note_ids
            logger.error(f"Commit failed, restoring rollback journal: {e}")
            try:
                await restore_rollback_journal(journal)
            except Exception:
                logger.exception("Rollback journal restore also failed")
            raise
