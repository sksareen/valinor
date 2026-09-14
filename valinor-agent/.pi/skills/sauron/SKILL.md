---
name: sauron
description: Recall recent machine/agent activity from Sauron's experience graph. Use when Savar asks what he was just doing, a past agent session, or to search recent activity.
---

# Sauron

Shells out to the Sauron CLI (`SAURON_BIN`, else `~/go/bin/sauron`). Read-only.

## Tool

`sauron_sessions`

- No args: recent experience records.
- `{ "query": "…" }`: search.
- `{ "limit": 20 }` optional.

If the CLI is missing or fails, say activity recall is unavailable — do not invent a timeline. Summarize; do not dump embeddings or raw JSON.
