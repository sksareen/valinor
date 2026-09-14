---
name: execute
description: List Savar's execution tasks (backlog, active, review, done). Use when he asks what he is working on, what's next, a task, or the execute tab. Call list_tasks; the task list is not in the every-turn digest. Not the same as live machine activity.
---

# Execute

Tasks live under `EXECUTE_DIR` (default `~/Savar/memory/execute`). Read-only here.

## When

- "What am I working on?" / "what's next?" / backlog / review
- Status of a named task

Not for: which app is frontmost or recent machine/cursor activity — that is skill `activity` / `recent_activity`. If he could mean either, call both.

## Tool

`list_tasks`

- No args: compact list (newest first).
- `{ "id": "<task-id>" }`: one task.

Statuses move Backlog → Active → Review → Done. Summarize; do not read proof URLs aloud.
