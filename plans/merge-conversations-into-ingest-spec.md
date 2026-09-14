# Spec: Merge Conversations into the Ingest Tab

> STATUS (2026-09-12): IMPLEMENTED in `ingest.html` + `POST /api/ingest/materialize`
> (`server.js`). Convos merge into the ingest list with filter chips, click-to-preview
> chat log, click/drag to Execute/Writing, on-demand materialization. `convos.html`
> kept as-is for now; retiring it as a hub tab is optional cleanup.
>
> REVERTED same day per user: conversations removed from the ingest list entirely —
> they live only in `convos.html` now. Ingest pivots to external pulls (email,
> iMessage). Already-materialized `convo-*.md` captures stay in the vault as plain
> captures. `POST /api/ingest/materialize` remains server-side (unused for now).

Source: voice capture `2026-09-12-112944-merge-conversations-into-ingest-tab`.
Ask: convos become just another kind of context inside Ingest — click shows the chat
log as a preview in the middle pane, and content can be dragged wherever it is needed.

## Goal

One context surface. Today captures (voice, screenshots, notes, cursor…) live in
`ingest.html` while agent conversations live separately in `convos.html` (backed by
Sauron's experience graph via `GET /api/conversations`). After this change, opening
Ingest shows both: captures and conversations in one filterable list, clicking any row
previews it in the middle detail pane, and any row can be sent (click) or dragged to
Execute / Writing.

## Current state (ground truth)

- `ingest.html`: two-pane layout — 300px list (`#list`, `.item` rows) + middle detail
  (`#detail` renders markdown + image). Rows already support click-to-preview,
  per-row To-Execute / To-Writing / enhance / delete, and `#detailBar` actions.
  Data: `GET /api/ingest` → `{items: [{id, title, created, source, preview, image}]}`,
  `GET /api/ingest/item?id=` → full markdown record.
- `convos.html`: standalone page over `GET /api/conversations` (Sauron
  `experience recent/search --json`, normalized to a flat list). Has search + tag
  chips + project grouping. Records carry `created_at`, `task_intent`, `outcome`,
  `approach`, `tools_used` — no markdown body, no stable file id.
- The new global ingest drawer (`ingest-drawer.js`) already offers click-to-send from
  any tab; whatever we build here should reuse its send endpoints, not fork them.

## Proposed UX

1. **Unified list.** Conversation rows appear inline in the Ingest list with a `convo`
   source badge (distinct accent), ordered by timestamp together with captures.
   The existing source filter gains a `convo` chip; text search matches intent +
   outcome + approach.
2. **Click → preview in the middle.** Clicking a convo row renders the chat log in
   `#detail`: title/intent header, outcome + approach summary, tools used, and the
   message turns if available from the record — same reading experience as a capture,
   clearly badged as a conversation.
3. **Act on it.** Each convo row and the detail bar get the same To Execute /
   To Writing actions captures have. To Execute snapshots intent + outcome as the
   task context; To Writing routes it as an idea. (Click-to-send first; true HTML5
   drag-and-drop onto Execute/Writing targets as a phase-2 enhancement — matches the
   "click to send" decision already made for the drawer.)
4. `convos.html` stays as the power-user view (grouping, tag filters) until the
   merged list reaches parity; then it becomes a thin redirect or is retired.

## Data & API design

- **Virtual, not materialized.** Do NOT write convo records into the ingest store as
  `.md` files — Sauron's graph is the source of truth (ids, timestamps) and
  duplication would rot. Instead add a server-side merge:
  - `GET /api/ingest?include=convos` (default on) returns captures plus mapped convo
    rows: `{id: 'convo:<record-id>', title: intent, created: created_at,
    source: 'convo', preview: outcome||approach slice}`.
  - `GET /api/ingest/item?id=convo:<record-id>` returns a synthesized markdown
    record (`ingest-server.readCapture`-shaped: `{id, meta, markdown}`) built from
    the Sauron record, so the detail pane, drawer, and all send paths work
    unchanged. Cache synthesized records in-memory with a short TTL; Sauron exec
    calls stay as-is (8s timeout, empty-list fallback).
- **ID namespacing.** The `convo:` prefix keeps the two id spaces disjoint for
  routing (`/api/writing/route`, execute `sourceIngestId`, history, dedup sets).
  `claimedIngestIds()` in `execute-server.js` must understand `convo:` ids so Scan
  never double-claims a conversation (or explicitly exclude convos from Scan until
  phase 2 — recommended default).
- **Send paths.** No new endpoints: execute `createTask({sourceIngestId})` snapshots
  via `fillSourceContext` — extend it to resolve `convo:` ids through the
  synthesizer; `writingPipeline.routeFromIngest` likewise reads through
  `ingest.readCapture`, so teach `readCapture` (or a wrapper) the `convo:` prefix.

## Phases

- **Phase 1 (this spec):** merged list + convo chip + middle-pane preview + click
  To Execute / To Writing. Scan excludes convos.
- **Phase 2:** HTML5 drag-and-drop from ingest rows onto Execute columns / Writing
  inbox; Scan opt-in for convos; retire-or-redirect `convos.html`.

## Risks & open questions

- Sauron binary latency/failure on list (already tolerated: 8s timeout, `[]`
  fallback) — the merged list must render captures immediately and fill convos in.
- Record shape variance between `search` (`{record, score}`) and `recent` (flat) —
  reuse the existing normalizer in the `/api/conversations` route.
- Convo message turns may be long — cap synthesized markdown (e.g. 6k chars) with a
  "full log in Convos" link.
- Hotel California check: `ingest.html?id=` deep links and the drawer must accept
  `convo:` ids everywhere a capture id is accepted.

## Acceptance

- Ingest list shows captures + convos interleaved by time with a working `convo`
  filter chip; search matches convo intents.
- Clicking a convo renders its log in the middle pane with To Execute / To Writing
  working and landing with full context attached.
- No `.md` files written for convos; Sauron outage still shows captures.
- Drawer, Scan dedup, and deep links all tolerate `convo:` ids.
