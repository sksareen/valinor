"""
Embedding helpers via OpenRouter/OpenAI, cached by content hash.
"""
import hashlib
import logging
import os
from typing import Dict, List, Optional

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

logger = logging.getLogger(__name__)

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "openai/text-embedding-3-small")

_cache: Dict[str, List[float]] = {}
_client: Optional[OpenAI] = None


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        if not OPENROUTER_API_KEY:
            raise ValueError("OPENROUTER_API_KEY not found in environment variables")
        _client = OpenAI(base_url=OPENROUTER_BASE_URL, api_key=OPENROUTER_API_KEY)
    return _client


def embed(text: str, *, use_cache: bool = True) -> List[float]:
    """Return an embedding vector for `text`, cached by content hash."""
    if not text or not text.strip():
        return []

    key = content_hash(text)
    if use_cache and key in _cache:
        return _cache[key]

    client = _get_client()
    response = client.embeddings.create(model=EMBEDDING_MODEL, input=text)
    vector = list(response.data[0].embedding)
    _cache[key] = vector
    logger.info(f"Embedded text ({len(text)} chars) with {EMBEDDING_MODEL}")
    return vector
