# Proposal: Promote Settings to a Full Main Window

Source: voice capture `2026-09-12-113021-settings-as-a-full-main-window`
("promote the settings slide-out tab into its own full main window" — accessibility + usability).

## Problem

Settings today is a slide-over panel (`#settingsPanel` in `hub.html`) sharing space with
whatever tab is open. It now holds two full sections — **Menu** (Theme, Color, Font, Size,
Spacing, Layout, Fit, Tabs, Corners, Live voice, Navigation, Tab order, Valinor memory,
Data, Models, Shortcuts) and **Profile** (Name, Call me, Role, Location, About, Voice) —
and it keeps growing (TTS preview, server-info docs, restart). In a narrow overlay that
means long scrolling, cramped segmented controls, and no room for explanations, search,
or per-section deep-linking. It is also unreachable by the tab system: no nav key, no
parked state, no direct link.

## Proposal

Give Settings its own full main-window view — a first-class tab alongside LIVE / INGEST /
EXECUTE / WRITING — with room to breathe: sections as cards, inline help, search, and a
layout that works at any window size.

## UX sketch

- New **SETTINGS** tab in the hub bar (position: after MESSAGES or at the end; user
  re-orderable via the existing Tab order control).
- Sections become full-width cards: Appearance, Layout & Tabs, Voice & Live, Navigation
  & Tab order, Memory & Data, Models, Shortcuts, Profile. Same controls as today, just
  laid out in a responsive grid instead of a 320px column.
- Add: filter-as-you-type search across settings, per-section anchor links
  (`hub.html` can route `#settings/appearance`), and inline descriptions for the
  non-obvious rows (Fit, Tab order zones, Valinor memory path).
- The slide-over stays as **quick access** (gear button / hotkey) for the 2–3 most
  touched rows (Theme, Layout), or is removed once the tab ships — decide at build time;
  keeping both is cheap since both bind the same backing controls.

## Implementation plan

1. Extract the settings panel markup + logic out of `hub.html` into a standalone
   `settings.html` page (same CSS vars, same localStorage keys — zero migration).
   The panel's controls already read/write localStorage + HubClient theme hooks, so
   extraction is mostly cut-paste plus a small message bridge (or shared
   `settings-store.js`) so panel and page never drift.
2. Register `{ key: 'settings', label: 'SETTINGS', src: 'settings.html' }` in
   `DEFAULT_VIEWS` (`hub.html` ~1228) so tab order, nav keys (1–7), parked frames,
   and cursor-capture context pick it up for free.
3. Keep `#settingsPanel` as a thin quick-access overlay bound to the same store, or
   delete it and point the gear button at the new tab.
4. Verify: toggle every control in the new tab, reload, confirm persistence; check the
   cursor-capture root sizing on the new page (full-body page — good regression case
   for the tiny-screenshot bug); confirm no duplicate element IDs between panel and
   page if both ship.

## Effort & risks

- Effort: small-medium. The controls exist; the work is extraction + a settings-store
  module + layout CSS. No server changes.
- Risk: two UIs bound to the same keys drifting (solved by the shared store module).
- Risk: scope creep into a full preferences redesign — cap v1 at parity + search.

## Alternatives considered

- **Widen the slide-over**: one-line change, but keeps every structural problem
  (no nav, no links, cramped at any width).
- **Settings inside an existing tab** (e.g. under hub Menu section): cheaper, but
  buries Profile + Models where nobody looks.

## Acceptance

- SETTINGS opens as a full tab, all current controls present and persisting.
- Search filters to the matching section; a section anchor link works from a cold load.
- Slide-over either updated (quick rows only) or removed with no dead buttons.
