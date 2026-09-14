---
name: activity
description: What Savar is doing on the machine now — frontmost app, recent timeline, light HW, latest cursor captures. Use when he asks what he is doing, which app he is in, or recent machine/cursor activity. Call recent_activity. Not ingest notes and not the execute task list.
---

# Activity

This is the Live Activity surface (machine monitor), not HTML. Call the tool; do not guess from the identity digest.

## When

- "What am I doing?" / "what am I working on right now?" at the computer
- Frontmost app, recent app switches, cursor screenshots
- Light CPU/memory if he asks how the machine feels

Not for: ingest captures (`search_ingest`), execute backlog (`list_tasks`), long Sauron experience search (`sauron_sessions`). If "working on" could mean tasks or the machine, call `recent_activity` and `list_tasks`.

## Tool

`recent_activity`

- Optional `{ "hours": 2, "limit": 8 }` — compact snapshot only.

If Sauron is down, say activity recall is thin — do not invent a timeline. Speak 1–3 sentences.
