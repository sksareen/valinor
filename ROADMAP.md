# VALINOR — Roadmap

A gestural HUD driven by webcam hand-tracking, with other apps consolidated
through a same-origin reverse proxy (`server.js` on :4777 · `PROXIED_APPS`).

## Shipped
- Hand tracking (MediaPipe), position-based L/R assignment, smooth interpolation
- Pinch = click/grab gesture; on-canvas L/R indicators
- Two-hand gravity + connecting line
- HUD modes: **BREATHE** (box pacer, click-to-start), **SYSTEM** (clock)
- **LOOPS** tab: Loopkeeper bundled under `./loopkeeper`, spawned by `server.js` on `:18003`, proxied same-origin via `PROXIED_APPS`
- Board voice agent + OpenRouter STT fallback; agent/convos tabs
- Hub shell: ⌘P tab palette, classic/drawer nav, clock geo+IP tip (copy on click), settings restart
- Activity / live surfaces; proto-OSS scrub (MIT, `.env.example`, loopback bind, no personal path defaults)
- Rehearse mock interview partner (voice interviewer + coach + TTS, config-driven persona)
- Execute / ingest / writing-loop surfaces; Live on the isolated Pi agent
- User-data separation: `data-home.js` (env → repo-compat → `~/.valinor`); board-notes migration

## Next
- [ ] **LEARN mode (Infinite Craft for ideas)** — the big one.
  - Topics float as orbs. **Pinch to open** → `claude -p` generates a tight
    explanation + spawns 3-4 related sub-topics as new orbs to explore.
  - **Bring two orbs together with both hands** (reuse the bond gesture) → they
    combine; `claude -p` synthesizes the intersection into a new orb.
  - Every discovery persists to disk (a growing idea-map Claude Code can curate).
  - Engine: server shells out to `claude -p` (OpenRouter optional), caches results.
- [ ] More proxied apps in valinor (same `PROXIED_APPS` + `VIEWS` pattern)
- [ ] Gesture-based mode switching (not just keys)
- [ ] Breathing: selectable patterns (4-7-8, box), session length, audio-optional
- [ ] Off-thread hand tracking (Web Worker) for lower latency
- [ ] Finish lightweight OSS checklist in `plans/lightweight-oss.md` (public visibility flip is manual)
