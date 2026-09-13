# Lightweight OSS scrub

Make hudhub safely public with a minimal scrub — strip personal content and hardcoded paths, add LICENSE + `.env.example`, tighten gitignore. LogAct is a separate later project and is out of scope here.

## Split

1. **This plan — lightweight OSS** so [sksareen/hudhub](https://github.com/sksareen/hudhub) can go public without leaking your machine.
2. **Later / separate — LogAct** (AgentBus + voters + Intent→Commit gate). See [logact-privacy-gate.md](logact-privacy-gate.md).

## Out of scope

Anything LogAct: no `logact/`, no AgentBus, no voters, no Intent wrapping of OpenRouter/PII reads.

## Work

### 1. Scrub personal content

- Stop tracking / remove personal pages (e.g. private letters, named stubs)
- Stop tracking / remove personal `letters/*`; ignore `letters/*` going forward (keep dir via `.gitkeep` if needed)
- Keep `notes.json` as `[]` only

### 2. Env-only personal paths

- `network-data.js` / `backfill-crm.js`: drop hardcoded absolute home-path defaults; require `NETWORK_DB_PATH` / `NETWORK_PEOPLE_DIR` / `CHAT_DB_PATH` (or soft-fail empty roster when unset)
- `package.json` loopkeeper / factory scripts: env docs or generic placeholders, not personal sibling paths
- README: document optional local plugs without absolute home paths

### 3. Secrets / local data stay local

Expand `.gitignore`:

- Already: `.env`, `drafts.json`, `crm.json`, `message-profile.json`, `live-session.jsonl`
- Add: `letters/*` (except `.gitkeep`)

Add:

- `LICENSE` (Apache-2.0)
- `.env.example` with `OPENROUTER_API_KEY=` and optional path vars (no real values)

### 4. Localhost bind

- `server.js`: `listen(PORT, process.env.HUDHUB_BIND || '127.0.0.1')`

### 5. Visibility flip is manual

Do **not** run `gh repo edit --visibility public` in this work. After scrub, review `git ls-files` and flip when ready.

## Verify

- `git ls-files` has no personal letters, no personal pages, no absolute home paths in tracked source
- `.env` / CRM / drafts still untracked
- Server without `NETWORK_DB_PATH` still boots; messages degrade cleanly
- Bound to `127.0.0.1` unless overridden
