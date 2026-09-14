# Evals Design — ingest→execution + ingest→writing

*Status: design discussion, 2026-09-12. Writing loop first; execution parked. No eval system built yet.*

## 1. Goal

Introduce evals for the two core loops:
- **Loop A — ingest→execution**: capture → render/scan → suggestion → backlog → active → review → done (+ ingest write-back)
- **Loop B — ingest→writing**: route from ingest → research → thesis options → draft → in-review (`letters/*.md`)

North-star success criteria:
- Execution: **completed todos**. Tasks stuck in an intermediary step (backlog/active/review) are the failure signal — future system should notice proactively (ask what's wrong, break into smaller chunks, schedule dedicated time, or hybrid).
- Writing: drafts that sound like Savar on a good day, with real theses and cited facts — not generic "good writing."

## 2. What exists today (mapped 2026-09-12)

- No eval infra: no golden sets, judges, or scoring. Only unrelated SRS grades in `learn.html` and verifier language in `loopkeeper/`.
- Telemetry exists and is the natural eval data source: `agent-usage.js` / `agent-usage.jsonl` logs every OpenRouter call per surface (`ingest`, `execute`, `writing`, `writing-pipeline`) with model/latency/tokens/cost + truncated input/output.
- Execution render path: `renderNoteToSuggestion()` (auto, fire-and-forget) and `scanIngest()` (batch backstop) share `SCAN_PROMPT` in `execute-server.js`; guards via `claimedIngestIds()` + `skipped-ingest.json`, P1 "never a bare suggestion."
- Writing pipeline: `writing-pipeline.js` (`routeFromIngest` → `runResearch` (Exa→DDG) → `runOptions` → `runDraft`); voice via `writing-voice.js` (`writing-voice.md` profile + verbatim exemplars + `ANTI_TELLS`).

## 3. Trajectory inventory

- **Execution: partial trajectories exist.**
  - `~/Savar/memory/execute/tasks.json`: ~13 tasks, most with `sourceIngestId` → real captures in `~/Savar/memory/ingest/` (781 files).
  - `~/Savar/memory/execute/events.jsonl`: real chain `scan.started → suggestion.created → promoted/archived → exit.now/agent/schedule`.
  - Gaps: old done tasks have single-entry `state_history`; `intent/action_type/duration_bucket` null everywhere (Wave 1 fields never populated on real data); render I/O not preserved except truncated in `agent-usage.jsonl`.
- **Writing: zero trajectories.** `writing-projects.json` was `{ "projects": [] }` at time of check. Golden set must be bootstrapped from scratch.

## 4. Decision: writing first

Rationale: no legacy to be compatible with; voice-fidelity risk is the highest-unknown; narrow scope keeps first eval build cheap.

## 5. Writing eval tradeoffs (weighed, not yet decided)

1. **Per-stage vs end-to-end** — Lean per-stage (research / options / draft each with a narrow contract) over end-to-end only. Costs 3x judge setup but localizes breakage when tweaking `OPTIONS_SYSTEM` vs `draftSystem()`.
2. **Grading layers, cheapest first** —
   - Deterministic gates (free): banned-word list, opener check, citation-link presence, thesis-distinctness via overlap, structure length.
   - LLM judge (middle): thesis point-of-view vs both-sides mush, voice-profile match.
   - Human (anchor): ~10 drafts graded once to calibrate the judge; spot-check on drift. Never fully delegate "sounds like me."
   - Judge-model caution: avoid same-family flattery; judge with a different/stronger model than the generator.
3. **Golden set** — Bootstrap ~8-12 cases: half real ingest notes worth essaying, half synthetic edge cases (vague one-liner, rant, technical idea). Expected outputs as bullets ("must-find sources", "acceptable thesis directions"), not full reference drafts. Cache research briefs per case so draft/options evals don't re-pay Exa + tokens.
4. **Suggested first eval** — Freeze research+options on 5-6 golden braindumps; eval *only* draft voice/fidelity across model/prompt variants. Narrow, cheap, high-signal. (Pending confirmation that draft/voice is the most-mistrusted stage vs research-thin or thesis-mush.)

## 6. Parked: execution evals

- Mine completed vs stalled tasks from `tasks.json` + `events.jsonl`.
- Candidate online metric: % stuck in backlog/active > X days, backlog re-enter count, shallow review answers (e.g. literal "ok" exists in data).
- Needs render I/O logging before model-level evals are possible.

## 7. Open questions

- [ ] Is draft/voice the most-mistrusted writing stage, or is it research/options?
- [ ] Golden-set source: real private captures (gitignored) vs synthetic in-repo cases?
- [ ] Runner: `node evals/run.js` CLI vs hub tab vs nightly sample from `agent-usage.jsonl`?
- [ ] Gate policy: must evals pass before prompt/model changes deploy?
