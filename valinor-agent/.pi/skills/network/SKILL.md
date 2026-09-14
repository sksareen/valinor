---
name: network
description: Look up people in Savar's CRM and iMessage context. Use when he asks who someone is, how he knows them, last contact, or to find a person by name.
---

# Network

Requires `NETWORK_DB_PATH`. If the tool says it is unset, tell Savar the people store is not pointed at a database — do not invent a roster.

## Tool

`lookup_person`

- `{ "query": "Ada" }` — name search, then full context for a unique match (role, notes, recent thread).
- `{ "query": "42" }` — numeric CRM id.

If several people match, name the top few and ask which one. Do not recite phone numbers or emails unless he asked. Speak 1–3 sentences.
