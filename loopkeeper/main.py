import os
import logging
from fastapi import FastAPI, HTTPException, Depends
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import uuid
from datetime import datetime
from dotenv import load_dotenv
from contextlib import asynccontextmanager

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Startup/shutdown lifespan manager
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("🚀 Starting Savar AI backend...")
    
    # Initialize database (but don't fail if it's not available)
    try:
        from database import init_database
        await init_database()
        logger.info("✅ Database initialized successfully")
    except Exception as e:
        logger.warning(f"⚠️ Database initialization failed: {e}")
        logger.warning("⚠️ Continuing without database - conversations will not be persisted")
        # Set a flag to indicate database is unavailable
        app.state.database_available = False
    else:
        app.state.database_available = True
    
    yield
    
    # Shutdown
    logger.info("👋 Shutting down Savar AI backend...")

# Initialize FastAPI app
app = FastAPI(
    title="Savar AI", 
    description="Clean minimalist AI chat interface with conversation memory",
    lifespan=lifespan
)

# Configure CORS
allowed_origins = [
    "https://savarsareen.com",
    "https://www.savarsareen.com",
    "https://savar.ai",
    "https://www.savar.ai",
    "https://savarsareen.vercel.app",
]

# Allow all localhost/127.0.0.1 origins (any port) for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Conversation-Id"],
)

# Request/Response models
class ChatMessage(BaseModel):
    message: str
    conversation_id: Optional[str] = None
    context_type: Optional[str] = None  # e.g., '112', '196', '700'
    context_data: Optional[str] = None  # e.g., the current quote/technique text

class ChatResponse(BaseModel):
    response: str
    conversation_id: str
    message_id: str
    timestamp: str

# Initialize OpenRouter client
openrouter_client = None

try:
    # Add current directory to path first
    import sys
    import os
    current_dir = os.path.dirname(os.path.abspath(__file__))
    if current_dir not in sys.path:
        sys.path.insert(0, current_dir)
    
    from openrouter_client import OpenRouterClient
    openrouter_client = OpenRouterClient()
    logger.info("✅ OpenRouter client initialized successfully")
except Exception as e:
    logger.warning(f"OpenRouter client unavailable: {e} (loops UI still works)")

@app.get("/")
async def root():
    return {
        "message": "Savar AI API", 
        "status": "running",
        "timestamp": datetime.now().isoformat()
    }

@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "openrouter_available": openrouter_client is not None
    }

@app.post("/reload-prompt")
async def reload_prompt():
    """Reload system prompt from file (useful during development)"""
    try:
        if openrouter_client:
            openrouter_client.reload_system_prompt()
            return {"status": "success", "message": "System prompt reloaded"}
        else:
            raise HTTPException(status_code=503, detail="OpenRouter client not available")
    except Exception as e:
        logger.error(f"Error reloading prompt: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/chat", response_model=ChatResponse)
async def chat(chat_message: ChatMessage):
    """Main chat endpoint with conversation memory"""
    try:
        if not openrouter_client:
            raise HTTPException(status_code=503, detail="AI service not available")
        
        # Import memory manager
        from memory_manager import memory_manager
        
        # Get or create conversation
        conversation_id = await memory_manager.get_or_create_conversation(chat_message.conversation_id)
        
        # Get conversation context
        conversation_context = await memory_manager.get_conversation_context(conversation_id)
        
        # Store user message
        await memory_manager.add_message(
            conversation_id=conversation_id,
            role="user", 
            content=chat_message.message
        )
        
        # Get AI response with context
        response_data = openrouter_client.generate_response(
            prompt=chat_message.message,
            temperature=0.7,
            max_tokens=2000,
            conversation_context=conversation_context,
            context_type=chat_message.context_type,
            context_data=chat_message.context_data
        )
        
        # Store AI response
        await memory_manager.add_message(
            conversation_id=conversation_id,
            role="assistant",
            content=response_data["response"],
            tokens_used=response_data.get("tokens_used"),
            model_used=response_data.get("model_used")
        )
        
        message_id = str(uuid.uuid4())
        
        return ChatResponse(
            response=response_data["response"],
            conversation_id=conversation_id,
            message_id=message_id,
            timestamp=datetime.now().isoformat()
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Chat error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/chat-stream")
async def chat_stream(chat_message: ChatMessage):
    """Streaming chat endpoint. Uses Server-Sent Events (text/event-stream)."""
    try:
        if not openrouter_client:
            raise HTTPException(status_code=503, detail="AI service not available")

        from memory_manager import memory_manager

        conversation_id = await memory_manager.get_or_create_conversation(chat_message.conversation_id)
        conversation_context = await memory_manager.get_conversation_context(conversation_id)

        # Store user message immediately
        await memory_manager.add_message(
            conversation_id=conversation_id,
            role="user",
            content=chat_message.message
        )

        async def event_generator():
            full_text = []
            # Initial ping to flush headers through proxies
            yield b": init\n\n"
            # Optional artificial delay to make client-side streaming clearly visible
            import asyncio
            import os as _os
            try:
                _delay_ms = int(_os.getenv('STREAM_DELAY_MS', '50'))
            except Exception:
                _delay_ms = 0
            for chunk in openrouter_client.generate_response_stream(
                prompt=chat_message.message,
                temperature=0.7,
                max_tokens=2000,
                conversation_context=conversation_context,
                context_type=chat_message.context_type,
                context_data=chat_message.context_data
            ):
                if not chunk:
                    continue
                full_text.append(chunk)
                data = f"data: {chunk}\n\n".encode("utf-8")
                if _delay_ms > 0:
                    await asyncio.sleep(_delay_ms / 1000)
                yield data

            # Indicate completion
            yield b"event: done\ndata: [DONE]\n\n"

            # After stream ends, persist assistant message
            try:
                final_text = "".join(full_text)
                await memory_manager.add_message(
                    conversation_id=conversation_id,
                    role="assistant",
                    content=final_text,
                    tokens_used=None,
                    model_used=None
                )
            except Exception as _e:
                logger.error(f"Failed to persist streamed message: {_e}")

        headers = {
            "X-Conversation-Id": conversation_id,
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
        return StreamingResponse(event_generator(), media_type="text/event-stream", headers=headers)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Chat stream error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Conversation management endpoints
@app.get("/conversations")
async def list_conversations(limit: int = 50):
    """List recent conversations"""
    try:
        from memory_manager import memory_manager
        conversations = await memory_manager.list_conversations(limit=limit)
        return {"conversations": conversations}
    except Exception as e:
        logger.error(f"Error listing conversations: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/conversations/{conversation_id}")
async def get_conversation(conversation_id: str):
    """Get conversation details"""
    try:
        from memory_manager import memory_manager
        conversation = await memory_manager.get_conversation_info(conversation_id)
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return conversation
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting conversation: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Agentic run-loop routes + local portal UI
try:
    from pathlib import Path
    from fastapi.staticfiles import StaticFiles
    from fastapi.responses import FileResponse
    from routes_runs import router as runs_router
    from routes_loops import router as loops_router
    from routes_events import router as events_router

    app.include_router(runs_router)
    app.include_router(loops_router)
    app.include_router(events_router)
    _static_dir = Path(__file__).parent / "static"
    if _static_dir.is_dir():
        app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")

        @app.get("/loops")
        async def loops_portal():
            return FileResponse(_static_dir / "loops.html")

    logger.info("✅ Runs router mounted")
except Exception as e:
    logger.warning(f"⚠️ Failed to mount runs router: {e}")


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)