# Loopkeeper (embedded in Valinor)

Bundled with Valinor so the LOOPS tab does not depend on a
separate reverse-proxied process.

Valinor’s `server.js` starts this FastAPI app on `127.0.0.1:18003` and proxies
`/loops`, `/static/`, `/runs`, `/guided-runs/`, `/events` same-origin on `:4777`.

OpenRouter: set `OPENROUTER_API_KEY` in the handviz `.env` (inherited by the child).

Venv: needs **Python 3.12** (or 3.11). System `python3` on newer macOS may be 3.14,
which cannot install the pinned FastAPI/pydantic wheels — `server.js` / `./run.sh`
prefer `python3.12` when creating `venv/`.

Standalone (rare): `./run.sh`
