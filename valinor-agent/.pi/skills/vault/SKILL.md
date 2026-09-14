---
name: vault
description: Use when asked about identity, who I am, my life, goals, people, journal, threads, or resources. Read Savar's personal vault (PARA). Not CRM (use network) and not ingest captures (use ingest). For short learned facts Val already stored, prefer recall_memory.
---

# Vault

Root: `SAVAR_VAULT` if set, otherwise `~/Savar` (home + `Savar`). Always use that absolute root — never a hardcoded user path.

PARA layout:

- `02_areas/identity` — who he is, how he works
- `02_areas/goals` — current aims
- `02_areas/people` — notes on people (long-form; CRM is `lookup_person`)
- `02_areas/journal` — journal entries
- `02_areas/threads` — ongoing threads
- `03_resources` — reference material

Use the `read` tool on a **specific markdown file** with an absolute path (e.g. `$SAVAR_VAULT/02_areas/identity.md` or a file inside those folders). Do not try to ingest the whole tree. If a path 404s, try a nearby `.md` he named, or say you do not have that file.

Do not volunteer private relationship content unless he asked and it is in the file you read.
