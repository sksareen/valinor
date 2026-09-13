"""
Database setup supporting both SQLite (local dev) and PostgreSQL (production)
"""
import os
import asyncio
from pathlib import Path
from datetime import datetime
from dotenv import load_dotenv

# Ensure DATABASE_URL is loaded before module-level engine setup (imports/tests/scripts).
load_dotenv(Path(__file__).resolve().parent / ".env")
from sqlalchemy import (
    create_engine,
    Column,
    String,
    Text,
    Integer,
    DateTime,
    ForeignKey,
    Boolean,
    UniqueConstraint,
)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
import logging

logger = logging.getLogger(__name__)

# Local dev default: loops_demo.db holds runs + custom loop templates.
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./loops_demo.db")

# Convert PostgreSQL URL for async if needed
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
    
    # Remove any existing sslmode parameters
    if "sslmode=" in DATABASE_URL:
        if "?" in DATABASE_URL:
            base_url = DATABASE_URL.split("?")[0]
            params = DATABASE_URL.split("?")[1].split("&")
            filtered_params = [param for param in params if not param.startswith("sslmode=")]
            if filtered_params:
                DATABASE_URL = base_url + "?" + "&".join(filtered_params)
            else:
                DATABASE_URL = base_url
    
    logger.info(f"✅ Using PostgreSQL database (cleaned URL)")
else:
    logger.info("✅ Using SQLite database (local development)")

# Create async engine with proper SSL configuration for PostgreSQL
if "postgresql" in DATABASE_URL:
    # For Fly.io internal connections, we don't need SSL
    engine = create_async_engine(
        DATABASE_URL,
        echo=False,
        pool_size=10,
        max_overflow=20,
        pool_pre_ping=True,
        connect_args={
            "ssl": None,  # Let asyncpg handle SSL negotiation
            "server_settings": {
                "application_name": "valinor-loopkeeper"
            },
            "command_timeout": 60
        }
    )
else:
    engine = create_async_engine(DATABASE_URL, echo=False)

async_session = async_sessionmaker(engine, expire_on_commit=False)

Base = declarative_base()

class Conversation(Base):
    __tablename__ = "conversations"
    
    id = Column(String, primary_key=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    title = Column(String, nullable=True)  # Auto-generated from first message
    message_count = Column(Integer, default=0)
    
    # Relationship to messages
    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan")

class Message(Base):
    __tablename__ = "messages"
    
    id = Column(String, primary_key=True)
    conversation_id = Column(String, ForeignKey("conversations.id"), nullable=False)
    role = Column(String, nullable=False)  # 'user' or 'assistant'
    content = Column(Text, nullable=False)
    timestamp = Column(DateTime, default=datetime.utcnow)
    tokens_used = Column(Integer, nullable=True)
    model_used = Column(String, nullable=True)
    
    # Relationship to conversation
    conversation = relationship("Conversation", back_populates="messages")


class Note(Base):
    __tablename__ = "notes"

    id = Column(String, primary_key=True)
    title = Column(String, nullable=False, default="")
    body = Column(Text, nullable=False, default="")
    tags = Column(Text, nullable=False, default="[]")  # JSON array
    embedding = Column(Text, nullable=True)  # JSON float array
    content_hash = Column(String, nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    links_out = relationship(
        "NoteLink",
        foreign_keys="NoteLink.src_note_id",
        back_populates="src_note",
        cascade="all, delete-orphan",
    )
    links_in = relationship(
        "NoteLink",
        foreign_keys="NoteLink.dst_note_id",
        back_populates="dst_note",
        cascade="all, delete-orphan",
    )


class NoteLink(Base):
    __tablename__ = "note_links"
    __table_args__ = (
        UniqueConstraint("src_note_id", "dst_note_id", "rel", name="uq_note_link_triplet"),
    )

    id = Column(String, primary_key=True)
    src_note_id = Column(String, ForeignKey("notes.id"), nullable=False)
    dst_note_id = Column(String, ForeignKey("notes.id"), nullable=False)
    rel = Column(String, nullable=False, default="related")
    created_at = Column(DateTime, default=datetime.utcnow)

    src_note = relationship("Note", foreign_keys=[src_note_id], back_populates="links_out")
    dst_note = relationship("Note", foreign_keys=[dst_note_id], back_populates="links_in")


class Run(Base):
    __tablename__ = "runs"

    id = Column(String, primary_key=True)
    intent = Column(Text, nullable=True)
    input_query = Column(Text, nullable=False)
    status = Column(String, nullable=False, default="DISCOVER")
    attempt = Column(Integer, nullable=False, default=0)
    max_attempts = Column(Integer, nullable=False, default=3)
    committed = Column(Boolean, nullable=False, default=False)
    staged_diff = Column(Text, nullable=True)  # JSON staged ops pending commit
    plan = Column(Text, nullable=True)  # JSON current plan
    failure_reasons = Column(Text, nullable=True)  # JSON list
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    steps = relationship("RunStep", back_populates="run", cascade="all, delete-orphan")


class RunStep(Base):
    __tablename__ = "run_steps"

    id = Column(String, primary_key=True)
    run_id = Column(String, ForeignKey("runs.id"), nullable=False)
    state = Column(String, nullable=False)
    input = Column(Text, nullable=True)  # JSON
    output = Column(Text, nullable=True)  # JSON
    created_at = Column(DateTime, default=datetime.utcnow)

    run = relationship("Run", back_populates="steps")


class UiEvent(Base):
    """Client-side Loops UX events for design hill-climb metrics."""

    __tablename__ = "ui_events"

    id = Column(String, primary_key=True)
    run_id = Column(String, nullable=True, index=True)
    kind = Column(String, nullable=False, index=True)
    loop_kind = Column(String, nullable=True, index=True)
    stage_number = Column(Integer, nullable=True)
    meta_json = Column(Text, nullable=True)  # JSON object
    ts = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)


class LoopTemplate(Base):
    """User-created guided loop definitions (stage list + coach copy)."""

    __tablename__ = "loop_templates"

    id = Column(String, primary_key=True)  # slug
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True, default="")
    default_query = Column(Text, nullable=True, default="")
    color = Column(String, nullable=True)  # e.g. #7a9e6a
    tags_json = Column(Text, nullable=False, default="[]")
    statuses_json = Column(Text, nullable=False, default="[]")
    coach_json = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


async def init_database():
    """Initialize the database tables"""
    try:
        logger.info(f"🔍 Attempting to connect to database: {DATABASE_URL}")
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("✅ Database initialized successfully")
    except Exception as e:
        logger.error(f"❌ Failed to initialize database: {e}")
        logger.error(f"❌ Error type: {type(e).__name__}")
        import traceback
        logger.error(f"❌ Full traceback: {traceback.format_exc()}")
        raise

async def get_session() -> AsyncSession:
    """Get a database session"""
    async with async_session() as session:
        try:
            yield session
        except Exception as e:
            await session.rollback()
            raise
        finally:
            await session.close()