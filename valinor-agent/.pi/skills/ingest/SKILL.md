---
name: ingest
description: Search and read Savar's ingest captures — voice notes, screenshots, and refined plans. Use when he asks what he captured, a recent note, a screenshot, an ingest plan, or "that capture". Call search_ingest; this is not in the every-turn digest.
---

# Ingest

Captures live under `INGEST_DIR` (default `~/Savar/memory/ingest`). Do not guess paths; use the tool. Do not invent titles from the identity digest.

## When

- "What did I capture / ingest?"
- A screenshot, voice note, Apple note, or refined plan
- A specific capture he names

Not for: execute tasks (`list_tasks`), what app he is in now (`recent_activity`), CRM people (`lookup_person`).

## Tool

`search_ingest`

- No args, or `{ "query": "…" }`: recent captures (id, title, created, preview). Filter with query when he named a topic.
- `{ "id": "<capture-id>" }`: full markdown for that capture.

Speak a short answer from the result. Do not dump the whole capture unless he asks for detail.
