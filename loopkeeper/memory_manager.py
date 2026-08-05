"""
Simple conversation memory manager with fallback to in-memory storage
"""
import uuid
import logging
from typing import List, Dict, Optional, Tuple
from datetime import datetime

logger = logging.getLogger(__name__)

class MemoryManager:
    """Handles conversation persistence and context retrieval"""
    
    def __init__(self):
        self.max_context_messages = 20  # Keep last 20 messages for context
        self.database_available = True
        self.in_memory_conversations = {}  # Fallback storage
        self.in_memory_messages = {}  # conversation_id -> list of messages
        
    def _use_database(self) -> bool:
        """Check if database is available"""
        try:
            from main import app
            return getattr(app.state, 'database_available', False)
        except:
            return False
    
    async def get_or_create_conversation(self, conversation_id: Optional[str] = None) -> str:
        """Get existing conversation or create new one"""
        if not conversation_id:
            conversation_id = str(uuid.uuid4())
        
        if self._use_database():
            try:
                from sqlalchemy import select
                from database import Conversation, get_session
                
                async for session in get_session():
                    try:
                        # Check if conversation exists
                        result = await session.execute(
                            select(Conversation).where(Conversation.id == conversation_id)
                        )
                        conversation = result.scalar_one_or_none()
                        
                        if not conversation:
                            # Create new conversation
                            conversation = Conversation(id=conversation_id)
                            session.add(conversation)
                            await session.commit()
                            logger.info(f"Created new conversation: {conversation_id}")
                        
                        return conversation_id
                        
                    except Exception as e:
                        logger.error(f"Error in get_or_create_conversation: {e}")
                        await session.rollback()
                        raise
            except Exception as e:
                logger.warning(f"Database unavailable, using in-memory storage: {e}")
                # Fall back to in-memory storage
                pass
        
        # In-memory fallback
        if conversation_id not in self.in_memory_conversations:
            self.in_memory_conversations[conversation_id] = {
                'id': conversation_id,
                'created_at': datetime.utcnow(),
                'message_count': 0
            }
            self.in_memory_messages[conversation_id] = []
            logger.info(f"Created new in-memory conversation: {conversation_id}")
        
        return conversation_id
    
    async def add_message(
        self, 
        conversation_id: str, 
        role: str, 
        content: str, 
        tokens_used: Optional[int] = None,
        model_used: Optional[str] = None
    ) -> str:
        """Add a message to the conversation"""
        message_id = str(uuid.uuid4())
        
        if self._use_database():
            try:
                from sqlalchemy import select
                from database import Conversation, Message, get_session
                
                async for session in get_session():
                    try:
                        # Create message
                        message = Message(
                            id=message_id,
                            conversation_id=conversation_id,
                            role=role,
                            content=content,
                            tokens_used=tokens_used,
                            model_used=model_used
                        )
                        session.add(message)
                        
                        # Update conversation
                        result = await session.execute(
                            select(Conversation).where(Conversation.id == conversation_id)
                        )
                        conversation = result.scalar_one_or_none()
                        
                        if conversation:
                            conversation.message_count += 1
                            conversation.updated_at = datetime.utcnow()
                            
                            # Auto-generate title from first user message
                            if conversation.message_count == 1 and role == "user":
                                # Use first 50 chars as title
                                title = content[:50].strip()
                                if len(content) > 50:
                                    title += "..."
                                conversation.title = title
                        
                        await session.commit()
                        logger.info(f"Added {role} message to conversation {conversation_id}")
                        return message_id
                        
                    except Exception as e:
                        logger.error(f"Error adding message: {e}")
                        await session.rollback()
                        raise
            except Exception as e:
                logger.warning(f"Database unavailable, using in-memory storage: {e}")
                # Fall back to in-memory storage
                pass
        
        # In-memory fallback
        if conversation_id not in self.in_memory_messages:
            self.in_memory_messages[conversation_id] = []
        
        message = {
            'id': message_id,
            'conversation_id': conversation_id,
            'role': role,
            'content': content,
            'tokens_used': tokens_used,
            'model_used': model_used,
            'timestamp': datetime.utcnow()
        }
        
        self.in_memory_messages[conversation_id].append(message)
        
        # Update conversation info
        if conversation_id in self.in_memory_conversations:
            self.in_memory_conversations[conversation_id]['message_count'] += 1
            
            # Auto-generate title from first user message
            if self.in_memory_conversations[conversation_id]['message_count'] == 1 and role == "user":
                title = content[:50].strip()
                if len(content) > 50:
                    title += "..."
                self.in_memory_conversations[conversation_id]['title'] = title
        
        logger.info(f"Added {role} message to in-memory conversation {conversation_id}")
        return message_id
    
    async def get_conversation_context(self, conversation_id: str) -> List[Dict[str, str]]:
        """Get recent messages for conversation context"""
        if self._use_database():
            try:
                from sqlalchemy import select, desc
                from database import Message, get_session
                
                async for session in get_session():
                    try:
                        # Get recent messages (excluding system messages)
                        result = await session.execute(
                            select(Message)
                            .where(Message.conversation_id == conversation_id)
                            .order_by(desc(Message.timestamp))
                            .limit(self.max_context_messages)
                        )
                        messages = result.scalars().all()
                        
                        # Convert to OpenAI format and reverse to chronological order
                        context = []
                        for message in reversed(messages):
                            context.append({
                                "role": message.role,
                                "content": message.content
                            })
                        
                        logger.info(f"Retrieved {len(context)} context messages for conversation {conversation_id}")
                        return context
                        
                    except Exception as e:
                        logger.error(f"Error getting conversation context: {e}")
                        return []
            except Exception as e:
                logger.warning(f"Database unavailable, using in-memory storage: {e}")
                # Fall back to in-memory storage
                pass
        
        # In-memory fallback
        if conversation_id not in self.in_memory_messages:
            return []
        
        messages = self.in_memory_messages[conversation_id]
        # Get recent messages (limit to max_context_messages)
        recent_messages = messages[-self.max_context_messages:]
        
        # Convert to OpenAI format
        context = []
        for message in recent_messages:
            context.append({
                "role": message["role"],
                "content": message["content"]
            })
        
        logger.info(f"Retrieved {len(context)} context messages from memory for conversation {conversation_id}")
        return context
    
    async def get_conversation_info(self, conversation_id: str) -> Optional[Dict]:
        """Get conversation metadata"""
        if self._use_database():
            try:
                from sqlalchemy import select
                from database import Conversation, get_session
                
                async for session in get_session():
                    try:
                        result = await session.execute(
                            select(Conversation).where(Conversation.id == conversation_id)
                        )
                        conversation = result.scalar_one_or_none()
                        
                        if conversation:
                            return {
                                "id": conversation.id,
                                "title": conversation.title,
                                "message_count": conversation.message_count,
                                "created_at": conversation.created_at.isoformat(),
                                "updated_at": conversation.updated_at.isoformat()
                            }
                        return None
                        
                    except Exception as e:
                        logger.error(f"Error getting conversation info: {e}")
                        return None
            except Exception as e:
                logger.warning(f"Database unavailable, using in-memory storage: {e}")
                # Fall back to in-memory storage
                pass
        
        # In-memory fallback
        if conversation_id in self.in_memory_conversations:
            conv = self.in_memory_conversations[conversation_id]
            return {
                "id": conv["id"],
                "title": conv.get("title", "New Conversation"),
                "message_count": conv["message_count"],
                "created_at": conv["created_at"].isoformat(),
                "updated_at": conv["created_at"].isoformat()  # No separate updated_at in memory
            }
        
        return None
    
    async def list_conversations(self, limit: int = 50) -> List[Dict]:
        """List recent conversations"""
        if self._use_database():
            try:
                from sqlalchemy import select, desc
                from database import Conversation, get_session
                
                async for session in get_session():
                    try:
                        result = await session.execute(
                            select(Conversation)
                            .order_by(desc(Conversation.updated_at))
                            .limit(limit)
                        )
                        conversations = result.scalars().all()
                        
                        return [
                            {
                                "id": conv.id,
                                "title": conv.title or "New Conversation",
                                "message_count": conv.message_count,
                                "updated_at": conv.updated_at.isoformat()
                            }
                            for conv in conversations
                        ]
                        
                    except Exception as e:
                        logger.error(f"Error listing conversations: {e}")
                        return []
            except Exception as e:
                logger.warning(f"Database unavailable, using in-memory storage: {e}")
                # Fall back to in-memory storage
                pass
        
        # In-memory fallback
        conversations = []
        for conv_id, conv in self.in_memory_conversations.items():
            conversations.append({
                "id": conv["id"],
                "title": conv.get("title", "New Conversation"),
                "message_count": conv["message_count"],
                "updated_at": conv["created_at"].isoformat()
            })
        
        # Sort by created_at (we don't track updated_at in memory)
        conversations.sort(key=lambda x: x["updated_at"], reverse=True)
        return conversations[:limit]

# Global memory manager instance
memory_manager = MemoryManager()