import os
import logging
import json
import re
from openai import OpenAI
from dotenv import load_dotenv
from typing import Dict, Any, Optional, Type, TypeVar
from pydantic import BaseModel, ValidationError
import time

T = TypeVar("T", bound=BaseModel)

# Load environment variables
load_dotenv()

logger = logging.getLogger(__name__)

# OpenRouter configuration
OPENROUTER_API_KEY = os.getenv('OPENROUTER_API_KEY')
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Default model for the Loopkeeper coach - using Claude Sonnet for quality
DEFAULT_MODEL = "anthropic/claude-sonnet-4"

def _read_file_if_exists(path: str) -> str:
    try:
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as f:
                return f.read().strip()
    except Exception as e:
        logger.warning(f"Could not read prompt fragment {path}: {e}")
    return ""

def load_wisdom_prompt(context_type: str) -> str:
    """Load a context-specific wisdom prompt if available."""
    try:
        base_dir = os.path.dirname(__file__)
        prompt_path = os.path.join(base_dir, 'prompt', 'wisdom', f'{context_type}.md')
        return _read_file_if_exists(prompt_path)
    except Exception as e:
        logger.warning(f"Could not load wisdom prompt for {context_type}: {e}")
    return ""

# Load system prompt from file(s)
def load_system_prompt():
    """Load system prompt, supporting modular prompt fragments if present.

    Order of assembly (if available):
    1) system_prompt.txt (base rules)
    2) prompt/persona.md
    3) prompt/facts.md
    4) prompt/examples.md

    Falls back to a sensible default if nothing is found.
    """
    try:
        base_dir = os.path.dirname(__file__)
        parts = []

        # 1) Base prompt
        base_prompt_path = os.path.join(base_dir, 'system_prompt.txt')
        base_prompt = _read_file_if_exists(base_prompt_path)
        if base_prompt:
            parts.append(base_prompt)

        # 2-4) Optional modular prompts
        prompt_dir = os.path.join(base_dir, 'prompt')
        if os.path.isdir(prompt_dir):
            for name in ['persona.md', 'facts.md', 'examples.md']:
                fragment_path = os.path.join(prompt_dir, name)
                fragment = _read_file_if_exists(fragment_path)
                if fragment:
                    parts.append(fragment)

        combined = "\n\n".join([p for p in parts if p]).strip()
        if combined:
            return combined
    except Exception as e:
        logger.warning(f"Could not load system prompt: {e}")

    # Fallback prompt
    return "You are a loop coach inside Valinor, a helpful and concise AI assistant."

class OpenRouterClient:
    def __init__(self):
        if not OPENROUTER_API_KEY:
            raise ValueError("OPENROUTER_API_KEY not found in environment variables")
        
        # Clear any proxy environment variables that might interfere
        proxy_vars = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']
        original_proxies = {}
        for var in proxy_vars:
            if var in os.environ:
                original_proxies[var] = os.environ[var]
                del os.environ[var]
        
        try:
            self.client = OpenAI(
                base_url=OPENROUTER_BASE_URL,
                api_key=OPENROUTER_API_KEY
            )
            self.model = DEFAULT_MODEL
            self.system_prompt = load_system_prompt()
            logger.info(f"OpenRouter client initialized with model: {self.model}")
        except Exception as e:
            # Restore proxy environment variables if initialization fails
            for var, value in original_proxies.items():
                os.environ[var] = value
            raise e
    
    def _build_system_prompt(self, context_type: Optional[str] = None, context_data: Optional[str] = None) -> str:
        """Build system prompt with optional wisdom context."""
        parts = []
        
        # Add wisdom-specific prompt if context_type provided
        if context_type:
            wisdom_prompt = load_wisdom_prompt(context_type)
            if wisdom_prompt:
                parts.append(wisdom_prompt)
            else:
                # Fallback to base prompt if no wisdom prompt found
                parts.append(self.system_prompt)
        else:
            parts.append(self.system_prompt)
        
        # Add the current quote/technique context
        if context_data:
            parts.append(f"\n\n## Current Context\nThe user is currently reading:\n\n> {context_data}\n\nHelp them understand and practice this specific technique.")
        
        return "\n\n".join(parts)

    def generate_response(
        self, 
        prompt: str,
        model: Optional[str] = None,
        max_tokens: int = 2000,
        temperature: float = 0.7,
        conversation_context: Optional[list] = None,
        context_type: Optional[str] = None,
        context_data: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Generate a response using OpenRouter with conversation context
        
        Args:
            prompt: User message/prompt
            model: Optional model override
            max_tokens: Maximum tokens to generate
            temperature: Sampling temperature (0-1)
            conversation_context: List of previous messages for context
            context_type: Type of wisdom text (e.g., '112', '196', '700')
            context_data: Current quote/technique text
        
        Returns:
            Dict with response data
        """
        try:
            start_time = time.time()
            
            # Use provided model or default
            use_model = model or self.model
            
            # Build system prompt with context
            system_prompt = self._build_system_prompt(context_type, context_data)
            
            # Prepare messages with conversation context
            messages = [{"role": "system", "content": system_prompt}]
            
            # Add conversation context if provided
            if conversation_context:
                messages.extend(conversation_context)
            
            # Add current user message
            messages.append({"role": "user", "content": prompt})
            
            logger.info(f"Generating response with {use_model} (context: {len(conversation_context) if conversation_context else 0} messages)")
            
            # Make API call
            response = self.client.chat.completions.create(
                model=use_model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                stream=False
            )
            
            # Calculate response time
            response_time_ms = int((time.time() - start_time) * 1000)
            
            # Extract response content
            content = response.choices[0].message.content
            
            logger.info(f"Response generated in {response_time_ms}ms")
            
            return {
                "response": content,
                "model_used": use_model,
                "response_time_ms": response_time_ms,
                "tokens_used": response.usage.total_tokens if hasattr(response, 'usage') else None
            }
            
        except Exception as e:
            logger.error(f"Error generating response: {e}")
            raise Exception(f"Failed to generate response: {str(e)}")

    def generate_response_stream(
        self,
        prompt: str,
        model: Optional[str] = None,
        max_tokens: int = 2000,
        temperature: float = 0.7,
        conversation_context: Optional[list] = None,
        context_type: Optional[str] = None,
        context_data: Optional[str] = None
    ):
        """
        Stream a response using OpenRouter, yielding incremental text chunks.
        """
        use_model = model or self.model
        system_prompt = self._build_system_prompt(context_type, context_data)
        messages = [{"role": "system", "content": system_prompt}]
        if conversation_context:
            messages.extend(conversation_context)
        messages.append({"role": "user", "content": prompt})

        try:
            stream = self.client.chat.completions.create(
                model=use_model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                stream=True
            )
            for event in stream:
                try:
                    delta = event.choices[0].delta
                    if delta and getattr(delta, 'content', None):
                        yield delta.content
                except Exception:
                    # Fallback for any unexpected event shape
                    pass
        except Exception as e:
            logger.error(f"Error streaming response: {e}")
            raise
    
    def generate_structured(
        self,
        prompt: str,
        schema: Type[T],
        *,
        system: Optional[str] = None,
        model: Optional[str] = None,
        max_tokens: int = 3000,
        temperature: float = 0.2,
    ) -> T:
        """
        One LLM call that must return JSON matching the given Pydantic schema.
        Instructs the model to emit only JSON; parses and validates the result.
        """
        use_model = model or self.model
        schema_json = json.dumps(schema.model_json_schema(), indent=2)
        system_prompt = system or (
            "You are a structured planning engine. "
            "Respond with ONLY valid JSON that matches the provided schema. "
            "No markdown fences, no commentary."
        )
        user_prompt = (
            f"{prompt}\n\n"
            f"JSON Schema:\n{schema_json}\n\n"
            "Return only the JSON object."
        )
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        logger.info(f"generate_structured with {use_model} -> {schema.__name__}")
        response = self.client.chat.completions.create(
            model=use_model,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
            stream=False,
        )
        content = response.choices[0].message.content or ""
        data = self._extract_json(content)
        try:
            return schema.model_validate(data)
        except ValidationError as e:
            logger.error(f"Structured output failed validation: {e}")
            raise ValueError(f"LLM output did not match schema: {e}") from e

    @staticmethod
    def _extract_json(text: str) -> Any:
        text = text.strip()
        # Strip markdown fences if present
        fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
        if fence:
            text = fence.group(1).strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # Try to find the first {...} object
            start = text.find("{")
            end = text.rfind("}")
            if start >= 0 and end > start:
                return json.loads(text[start : end + 1])
            raise

    def set_system_prompt(self, prompt: str):
        """Update the system prompt"""
        self.system_prompt = prompt
        logger.info("System prompt updated")
    
    def reload_system_prompt(self):
        """Reload system prompt from file"""
        self.system_prompt = load_system_prompt()
        logger.info("System prompt reloaded from file")