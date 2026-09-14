---
name: web
description: Current facts from the web or public APIs — sunset/sunrise, weather, news, sports scores, anything that needs a live lookup. Use lookup. Not Wikipedia-on-the-board.
---

# Web lookup

Call `lookup`. Do not call `play_video` or `show_article` to answer the question. The board is only if Savar wants a card or video **on screen**.

Now + place is already in the turn digest (ISO, local clock from this Mac's OS timezone, city, lat/lng). Use that date and location. Do not ask which city if geo is present. "What time is it" needs no tool — read the digest. If location is marked approximate, say so briefly.

## When

- Sunset / sunrise / dusk / dawn today
- Weather, temperature, forecast
- News, scores, "who won", anything that changes
- A fact you would otherwise guess or Wikipedia (spoken — not `show_article`)

## Tool

`lookup`

- `{ "query": "sunset today" }` — if geo exists, hits a sun API and returns local times
- `{ "query": "weather" }` — forecast when lat/lng exist
- `{ "query": "…" }` — compact web results (title, snippet, url). Exa if `EXA_API_KEY` is set, otherwise DuckDuckGo.

Speak 1–3 sentences. Cite local clock time ("sunset was 7:52 pm"). Do not read URLs unless he asked.
