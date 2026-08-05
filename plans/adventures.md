# Adventures: shared human/agent work cycles

## Overview

Add a first-class "loop" concept to Sauron — reusable stage templates plus long-running instances whose ledger interleaves your turns and the agent's turns — then surface it as an **Adventures** tab in Valinor, with agent sessions auto-attaching via the existing stop hooks.

Loopkeeper stays as-is; we borrow its template/run split rather than depending on its FastAPI backend. Loop state lives in Sauron's SQLite — the only substrate both Cursor and Claude Code already reach (MCP) and that Valinor already reads (CLI, same as `/api/conversations`).

## Phases

1. **Schema** — `loop_templates` / `loops` / `loop_turns` + models + seed `ship-feature`, `debug-issue`, `research` ✅
2. **Store** — `internal/store/loops.go` CRUD (triage idioms)
3. **CLI** — `sauron loop` family with `--json`
4. **MCP** — `sauron_loops`, `sauron_loop_show`, `sauron_loop_step`, `sauron_loop_open`, `sauron_loop_close` (leave `sauron_current_loop` alone)
5. **Auto-attach** — `experience log --loop auto` from both stop hooks; abstain on 0 or many project matches
6. **Valinor API** — `/api/loops` GET/POST/step/close
7. **Valinor UI** — `adventures.html` whose-move rail, stage strip, interleaved ledger; attach from CONVOS
8. **Build / verify** — install to `~/go/bin/sauron`, walk one loop end to end

## Schema (Sauron)

Additive tables in `internal/store/db.go` (no existing tables touched):

- **`loop_templates`** — `template_id`, `name`, `description`, `kind` (`human`|`agent`|`joint`), `stages_json`, `tags_json`
- **`loops`** — `loop_id`, `template_id`, `title`, `projects_json` (multi-repo), `kind`, `stage`, `status` (`open`|`blocked`|`done`|`abandoned`), `whose_move` (`human`|`agent`|`either`), `next_action`, `stages_json` (instance snapshot), timestamps
- **`loop_turns`** — `loop_id`, `actor` (`human`|`agent`), `kind` (`intent`|`feedback`|`session`|`approval`|`blocker`|`stage`|`note`), `stage`, `summary`, `ref_type`/`ref_id` (join to `experiences`), `created_at`

Indexes: `loops(status, updated_at DESC)`, `loop_turns(loop_id, created_at)`.

Seeded joint templates: ship-feature, debug-issue, research.

## Handoffs

Deterministic, not inferred:

- human turn → agent's move
- agent turn → your move
- `note` does not flip
- `blocker` → `status=blocked`, move returns to you
- explicit `--whose-move` always wins
- stage changes only when a turn sets `--stage`, validated against the instance snapshot

## Auto-attach

`--loop <id|auto>` + `--loop-human-summary` on `sauron experience log`. With `auto`: match open loops whose `projects_json` contains the experience project slug. Exactly one → write human feedback + agent session turn, flip `whose_move` to human. Zero or many → abstain. Manual "attach to loop" in CONVOS is the fallback; attaching from a new repo appends that slug.

## Valinor

- API via `execFile` + `--json` (conversations pattern)
- UI: rail grouped Your move / Agent's move / Blocked; stage strip; interleaved ledger
- Register in `hub.html` VIEWS as **Adventures**
- Out of scope: migrating 2,614 stale `open_tasks` rows

## Verify

`go install ./cmd/sauron` → `~/go/bin/sauron`, restart daemon, open a `ship-feature` loop for `handviz`, let stop hook attach, confirm ledger + `whose_move`.
