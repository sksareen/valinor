#!/usr/bin/env python3
"""Long-lived Kitten TTS worker — JSONL on stdin/stdout.

Protocol (one JSON object per line):
  → {"id":1,"cmd":"speak","text":"hi","voice":"Jasper","speed":1.0}
  ← {"id":1,"ok":true,"path":".../out.wav","ms":90,"sample_rate":24000}
  → {"id":2,"cmd":"voices"}
  ← {"id":2,"ok":true,"voices":[...],"model":"...","ready":true}
  → {"id":3,"cmd":"ping"}
  ← {"id":3,"ok":true,"ready":true}
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE_DIR = Path(os.environ.get("KITTEN_TTS_CACHE", ROOT / "models"))
OUT_DIR = Path(os.environ.get("KITTEN_TTS_TMP", ROOT / "tmp"))
MODEL_ID = os.environ.get("KITTEN_TTS_MODEL", "KittenML/kitten-tts-mini-0.8")
VOICES = ["Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo"]

model = None


def reply(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def trim_leading_silence(audio, sr=24000, thresh_frac=0.015, pad_ms=20):
    """Drop Kitten's ~400ms of near-zero pad; keep a tiny attack pad."""
    import numpy as np
    a = np.asarray(audio, dtype=np.float32).reshape(-1)
    if a.size == 0:
        return a
    peak = float(np.max(np.abs(a))) or 1.0
    idx = np.flatnonzero(np.abs(a) >= peak * thresh_frac)
    if idx.size == 0:
        return a
    start = max(0, int(idx[0]) - int(sr * pad_ms / 1000.0))
    return a[start:]


def synthesize_audio(m, text, voice, speed, needs_clean):
    """One ONNX pass for a live sentence; fall back to full generate for long lines."""
    inner = getattr(m, "model", m)
    if needs_clean and hasattr(inner, "preprocessor"):
        text = inner.preprocessor(text)
    if hasattr(inner, "generate_single_chunk"):
        try:
            from kittentts.onnx_model import chunk_text
            chunks = chunk_text(text)
        except Exception:
            chunks = [text]
        if len(chunks) <= 1:
            piece = chunks[0] if chunks else text
            return inner.generate_single_chunk(piece, voice, speed)
        if hasattr(inner, "generate"):
            return inner.generate(text, voice=voice, speed=speed, clean_text=False)
    return m.generate(text, voice=voice, speed=speed, clean_text=needs_clean)


def ensure_model():
    global model
    if model is not None:
        return model
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # Import lazily so a missing install fails with a clean JSON error.
    from kittentts import KittenTTS

    t0 = time.time()
    sys.stderr.write(f"[kitten-tts] loading {MODEL_ID}…\n")
    sys.stderr.flush()
    model = KittenTTS(MODEL_ID, cache_dir=str(CACHE_DIR))
    sys.stderr.write(f"[kitten-tts] ready in {int((time.time() - t0) * 1000)}ms\n")
    sys.stderr.flush()
    return model


def handle(msg: dict) -> dict:
    cmd = str(msg.get("cmd") or "").strip().lower()
    rid = msg.get("id")
    if cmd == "ping":
        return {"id": rid, "ok": True, "ready": model is not None, "model": MODEL_ID}
    if cmd == "voices":
        voices = list(VOICES)
        try:
            m = ensure_model()
            avail = getattr(m, "available_voices", None)
            if avail:
                voices = list(avail)
        except Exception as e:
            return {"id": rid, "ok": False, "error": str(e), "voices": voices, "model": MODEL_ID}
        return {"id": rid, "ok": True, "voices": voices, "model": MODEL_ID, "ready": True}
    if cmd == "speak":
        text = str(msg.get("text") or "").strip()
        if not text:
            return {"id": rid, "ok": False, "error": "empty text"}
        voice = str(msg.get("voice") or "Jasper").strip() or "Jasper"
        if voice not in VOICES:
            # Accept aliases from available_voices after load; otherwise clamp.
            voice = "Jasper"
        try:
            speed = float(msg.get("speed") if msg.get("speed") is not None else 1.0)
        except (TypeError, ValueError):
            speed = 1.0
        speed = max(0.5, min(2.0, speed))
        try:
            m = ensure_model()
            # Prefer friendly names if the model exposes them.
            avail = list(getattr(m, "available_voices", None) or VOICES)
            if voice not in avail and avail:
                # Case-insensitive match, else first voice.
                match = next((v for v in avail if v.lower() == voice.lower()), None)
                voice = match or avail[0]
            t0 = time.time()
            OUT_DIR.mkdir(parents=True, exist_ok=True)
            import base64
            import io
            import soundfile as sf

            # Live lines are short plain English — skip clean_text unless digits/symbols need it.
            needs_clean = bool(__import__("re").search(r"[\d$€£%/]", text))
            audio = synthesize_audio(m, text, voice, speed, needs_clean)
            audio = trim_leading_silence(audio)
            buf = io.BytesIO()
            sf.write(buf, audio, 24000, format="WAV")
            wav = buf.getvalue()
            return {
                "id": rid,
                "ok": True,
                "wav_b64": base64.b64encode(wav).decode("ascii"),
                "voice": voice,
                "sample_rate": 24000,
                "bytes": len(wav),
                "ms": int((time.time() - t0) * 1000),
            }
        except Exception as e:
            return {"id": rid, "ok": False, "error": str(e), "trace": traceback.format_exc()[-800:]}
    return {"id": rid, "ok": False, "error": f"unknown cmd: {cmd}"}


def main() -> int:
    # Eager-load so /api/tts status is honest after boot.
    try:
        ensure_model()
        reply({"id": 0, "ok": True, "event": "ready", "model": MODEL_ID, "voices": VOICES})
    except Exception as e:
        reply({"id": 0, "ok": False, "event": "ready", "error": str(e)})
        # Keep reading so Node can surface the error on speak/voices.
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            reply({"ok": False, "error": f"bad json: {e}"})
            continue
        try:
            reply(handle(msg if isinstance(msg, dict) else {}))
        except Exception as e:
            reply({"id": (msg or {}).get("id") if isinstance(msg, dict) else None, "ok": False, "error": str(e)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
