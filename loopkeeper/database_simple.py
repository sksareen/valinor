"""
Simplified database setup with better error handling for Fly.io
"""
import os
import asyncio
from datetime import datetime
from sqlalchemy import create_engine, Column, String, Text, Integer, DateTime, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
import logging

logger = logging.getLogger(__name__)

# Get database URL from environment
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./conversations.db")

# Convert PostgreSQL URL for async if needed
if DATABASE_URL.startswith("postgres://"):
    # Convert to asyncpg format
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
    logger.info(f"✅ Using PostgreSQL database")
elif DATABASE_URL.startswith("postgresql://"):
    # Convert to asyncpg format
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)
    logger.info(f"✅ Using PostgreSQL database")
else:
    logger.info("✅ Using SQLite database (local development)")

# Create async engine with minimal configuration
try:
    if "postgresql" in DATABASE_URL:
        # For PostgreSQL, try without SSL first (Fly.io internal connections don't need SSL)
        engine = create_async_engine(
            DATABASE_URL,
            echo=False,
            pool_size=5,
            max_overflow=10,
            pool_pre_ping=True
        )
    else:
        # SQLite doesn't need special configuration
        engine = create_async_engine(DATABASE_URL, echo=False)
    
    async_session = async_sessionmaker(engine, expire_on_commit=False)
except Exception as e:
    logger.error(f"Failed to create database engine: {e}")
    # Fallback to SQLite if PostgreSQL fails
    logger.info("Falling back to SQLite database")
    DATABASE_URL = "sqlite+aiosqlite:///./conversations.db"
    engine = create_async_engine(DATABASE_URL, echo=False)
    async_session = async_sessionmaker(engine, expire_on_commit=False)

Base = declarative_base()

class Conversation(Base):
    __tablename__ = "conversations"
    
    id = Column(String, primary_key=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    title = Column(String, nullable=True)
    message_count = Column(Integer, default=0)
    
    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan")

class Message(Base):
    __tablename__ = "messages"
    
    id = Column(String, primary_key=True)
    conversation_id = Column(String, ForeignKey("conversations.id"), nullable=False)
    role = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    timestamp = Column(DateTime, default=datetime.utcnow)
    tokens_used = Column(Integer, nullable=True)
    model_used = Column(String, nullable=True)
    
    conversation = relationship("Conversation", back_populates="messages")

async def init_database():
    """Initialize the database tables"""
    try:
        logger.info(f"🔍 Attempting to initialize database tables...")
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("✅ Database tables created/verified successfully")
        return True
    except Exception as e:
        logger.error(f"❌ Failed to initialize database: {e}")
        return False

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