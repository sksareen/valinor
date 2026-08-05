"""
Execute-phase safeguards (long-term).

1. Preflight dry-run — validate every staged op with zero side effects.
   Execute must not produce a "successful" stage that cannot later apply cleanly.

2. Sealed artifact + rollback journal — freeze ops under a content hash;
   commit only applies that exact seal; on failure, restore prior snapshots.
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select

from database import Note, NoteLink, async_session
from notes_store import _parse_json, note_to_dict

logger = logging.getLogger(__name__)

ALLOWED_STAGED_OPS = frozenset({"createNote", "updateNote", "tag", "linkNotes", "embed"})


def _canonical_ops_json(ops: List[Dict[str, Any]]) -> str:
    # Hash only the ops payload (not metadata) so seal is stable.
    return json.dumps({"ops": ops}, sort_keys=True, separators=(",", ":"), default=str)


def seal_staged_diff(ops: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Freeze staged ops under a content hash. Execute never mutates live state."""
    canonical = _canonical_ops_json(ops)
    return {
        "ops": ops,
        "sealed": True,
        "mutate": False,  # hard invariant: EXECUTE stages only
        "content_hash": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        "sealed_at": datetime.utcnow().isoformat() + "Z",
    }


def verify_seal(diff: Dict[str, Any]) -> Optional[str]:
    """Return error string if seal is missing or mismatched; else None."""
    if not diff.get("sealed"):
        return "Staged diff is not sealed"
    ops = diff.get("ops")
    if not isinstance(ops, list):
        return "Staged diff ops must be a list"
    expected = diff.get("content_hash")
    actual = hashlib.sha256(_canonical_ops_json(ops).encode("utf-8")).hexdigest()
    if not expected or expected != actual:
        return "Staged diff content_hash mismatch (artifact tampered or corrupted)"
    if diff.get("mutate") is True:
        return "Staged diff illegally marked mutate=true (Execute must never mutate)"
    return None


async def preflight_staged_diff(diff: Dict[str, Any]) -> Dict[str, Any]:
    """
    Safeguard 1: dry-run validation of every op. No DB writes, no embeddings.

    Checks: known op types, required fields/types, referenced IDs exist,
    no self-links, non-empty meaningful payloads.
    """
    errors: List[str] = []
    ops = diff.get("ops") if isinstance(diff, dict) else None
    if not isinstance(ops, list) or not ops:
        return {"ok": False, "errors": ["Staged diff has no ops"], "checked": 0}

    # Collect IDs that createNote will introduce (later ops may reference them)
    pending_creates: set = set()

    async with async_session() as session:
        for i, op in enumerate(ops):
            prefix = f"ops[{i}]"
            if not isinstance(op, dict):
                errors.append(f"{prefix}: op must be an object")
                continue
            op_type = op.get("op")
            payload = op.get("payload") or {}
            if not isinstance(payload, dict):
                errors.append(f"{prefix}: payload must be an object")
                continue
            if op_type not in ALLOWED_STAGED_OPS:
                errors.append(f"{prefix}: unknown op '{op_type}'")
                continue

            if op_type == "createNote":
                title = payload.get("title", "")
                body = payload.get("body", "")
                tags = payload.get("tags", [])
                if not isinstance(title, str) or not isinstance(body, str):
                    errors.append(f"{prefix}.createNote: title and body must be strings")
                if tags is not None and (
                    not isinstance(tags, list) or not all(isinstance(t, str) for t in tags)
                ):
                    errors.append(f"{prefix}.createNote: tags must be a list of strings")
                if not (title or body):
                    errors.append(f"{prefix}.createNote: empty title and body")
                nid = payload.get("id")
                if nid is not None:
                    if not isinstance(nid, str) or not nid:
                        errors.append(f"{prefix}.createNote: id must be a non-empty string")
                    else:
                        pending_creates.add(nid)
                        res = await session.execute(select(Note.id).where(Note.id == nid))
                        if res.scalar_one_or_none():
                            # Idempotent create by id is OK — not an error
                            pass

            elif op_type == "updateNote":
                note_id = payload.get("note_id")
                if not note_id or not isinstance(note_id, str):
                    errors.append(f"{prefix}.updateNote: note_id required")
                elif note_id not in pending_creates:
                    res = await session.execute(select(Note.id).where(Note.id == note_id))
                    if not res.scalar_one_or_none():
                        errors.append(f"{prefix}.updateNote: note not found: {note_id}")
                if not any(k in payload for k in ("title", "body", "tags")):
                    errors.append(f"{prefix}.updateNote: no fields to update")
                if "title" in payload and not isinstance(payload["title"], str):
                    errors.append(f"{prefix}.updateNote: title must be string")
                if "body" in payload and not isinstance(payload["body"], str):
                    errors.append(f"{prefix}.updateNote: body must be string")
                if "tags" in payload and (
                    not isinstance(payload["tags"], list)
                    or not all(isinstance(t, str) for t in payload["tags"])
                ):
                    errors.append(f"{prefix}.updateNote: tags must be list of strings")

            elif op_type == "tag":
                note_id = payload.get("note_id")
                tags = payload.get("tags")
                if not note_id or not isinstance(note_id, str):
                    errors.append(f"{prefix}.tag: note_id required")
                elif note_id not in pending_creates:
                    res = await session.execute(select(Note.id).where(Note.id == note_id))
                    if not res.scalar_one_or_none():
                        errors.append(f"{prefix}.tag: note not found: {note_id}")
                if not isinstance(tags, list) or not tags or not all(isinstance(t, str) for t in tags):
                    errors.append(f"{prefix}.tag: tags must be a non-empty list of strings")

            elif op_type == "linkNotes":
                src = payload.get("src_note_id")
                dst = payload.get("dst_note_id")
                rel = payload.get("rel") or "related"
                if not src or not isinstance(src, str):
                    errors.append(f"{prefix}.linkNotes: src_note_id required")
                if not dst or not isinstance(dst, str):
                    errors.append(f"{prefix}.linkNotes: dst_note_id required")
                if src and dst and src == dst:
                    errors.append(f"{prefix}.linkNotes: cannot link a note to itself")
                if not isinstance(rel, str) or not rel.strip():
                    errors.append(f"{prefix}.linkNotes: rel must be a non-empty string")
                for label, nid in (("src", src), ("dst", dst)):
                    if not nid or not isinstance(nid, str):
                        continue
                    if nid in pending_creates:
                        continue
                    res = await session.execute(select(Note.id).where(Note.id == nid))
                    if not res.scalar_one_or_none():
                        errors.append(f"{prefix}.linkNotes: {label} note not found: {nid}")

            elif op_type == "embed":
                note_id = payload.get("note_id")
                if not note_id or not isinstance(note_id, str):
                    errors.append(f"{prefix}.embed: note_id required")
                elif note_id not in pending_creates:
                    res = await session.execute(select(Note.id).where(Note.id == note_id))
                    if not res.scalar_one_or_none():
                        errors.append(f"{prefix}.embed: note not found: {note_id}")

    return {"ok": len(errors) == 0, "errors": errors, "checked": len(ops)}


async def build_rollback_journal(ops: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Safeguard 2 helper: snapshot every entity that commit will touch,
    so a failed apply can restore prior state.
    """
    note_ids: set = set()
    link_keys: List[Tuple[str, str, str]] = []

    for op in ops:
        op_type = op.get("op")
        payload = op.get("payload") or {}
        if op_type in ("updateNote", "tag", "embed"):
            if payload.get("note_id"):
                note_ids.add(payload["note_id"])
        elif op_type == "createNote" and payload.get("id"):
            note_ids.add(payload["id"])
        elif op_type == "linkNotes":
            src, dst = payload.get("src_note_id"), payload.get("dst_note_id")
            rel = payload.get("rel") or "related"
            if src:
                note_ids.add(src)
            if dst:
                note_ids.add(dst)
            if src and dst:
                link_keys.append((src, dst, rel))

    notes_snap: Dict[str, Any] = {}
    links_snap: List[Dict[str, Any]] = []
    missing_notes: List[str] = []

    async with async_session() as session:
        for nid in note_ids:
            res = await session.execute(select(Note).where(Note.id == nid))
            note = res.scalar_one_or_none()
            if note:
                notes_snap[nid] = {
                    "exists": True,
                    "snapshot": {
                        "id": note.id,
                        "title": note.title,
                        "body": note.body,
                        "tags": note.tags,
                        "embedding": note.embedding,
                        "content_hash": note.content_hash,
                    },
                }
            else:
                notes_snap[nid] = {"exists": False}
                missing_notes.append(nid)

        for src, dst, rel in link_keys:
            res = await session.execute(
                select(NoteLink).where(
                    NoteLink.src_note_id == src,
                    NoteLink.dst_note_id == dst,
                    NoteLink.rel == rel,
                )
            )
            link = res.scalar_one_or_none()
            if link:
                links_snap.append(
                    {
                        "exists": True,
                        "id": link.id,
                        "src_note_id": src,
                        "dst_note_id": dst,
                        "rel": rel,
                    }
                )
            else:
                links_snap.append(
                    {
                        "exists": False,
                        "src_note_id": src,
                        "dst_note_id": dst,
                        "rel": rel,
                    }
                )

    return {
        "created_at": datetime.utcnow().isoformat() + "Z",
        "notes": notes_snap,
        "links": links_snap,
        "created_note_ids": [],  # filled during apply
    }


async def restore_rollback_journal(journal: Dict[str, Any]) -> None:
    """Restore notes/links from a rollback journal (best-effort after failed commit)."""
    async with async_session() as session:
        try:
            # Delete notes created during the failed apply
            for nid in journal.get("created_note_ids") or []:
                res = await session.execute(select(Note).where(Note.id == nid))
                note = res.scalar_one_or_none()
                if note:
                    await session.delete(note)

            # Restore prior note snapshots
            for nid, entry in (journal.get("notes") or {}).items():
                res = await session.execute(select(Note).where(Note.id == nid))
                note = res.scalar_one_or_none()
                if entry.get("exists") and entry.get("snapshot"):
                    snap = entry["snapshot"]
                    if note:
                        note.title = snap["title"]
                        note.body = snap["body"]
                        note.tags = snap["tags"]
                        note.embedding = snap.get("embedding")
                        note.content_hash = snap.get("content_hash")
                        note.updated_at = datetime.utcnow()
                    else:
                        session.add(
                            Note(
                                id=snap["id"],
                                title=snap["title"],
                                body=snap["body"],
                                tags=snap["tags"],
                                embedding=snap.get("embedding"),
                                content_hash=snap.get("content_hash"),
                            )
                        )
                elif not entry.get("exists") and note:
                    # Note didn't exist before and wasn't in created_note_ids path
                    await session.delete(note)

            # Restore links: delete newly created; recreate ones that existed
            for link_entry in journal.get("links") or []:
                res = await session.execute(
                    select(NoteLink).where(
                        NoteLink.src_note_id == link_entry["src_note_id"],
                        NoteLink.dst_note_id == link_entry["dst_note_id"],
                        NoteLink.rel == link_entry["rel"],
                    )
                )
                current = res.scalar_one_or_none()
                if link_entry.get("exists"):
                    if not current:
                        session.add(
                            NoteLink(
                                id=link_entry["id"],
                                src_note_id=link_entry["src_note_id"],
                                dst_note_id=link_entry["dst_note_id"],
                                rel=link_entry["rel"],
                            )
                        )
                else:
                    if current:
                        await session.delete(current)

            await session.commit()
            logger.info("Rollback journal restored successfully")
        except Exception:
            await session.rollback()
            logger.exception("Failed to restore rollback journal")
            raise
