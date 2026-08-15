"""Memory data model: types, priorities, sources, relationships, and the
canonical ``Memory`` object the agent operates on."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any


class MemoryType(StrEnum):
    EPISODIC = "episodic"  # what happened in past conversations/events
    SEMANTIC = "semantic"  # durable facts/preferences/projects/identity
    PROCEDURAL = "procedural"  # how the user does things (workflows, habits)
    RELATIONSHIP = "relationship"  # connections between people/topics/memories

    @classmethod
    def from_extractor(cls, raw: str) -> MemoryType:
        """Map the extractor's coarse type tags onto the richer enum."""
        value = (raw or "").strip().lower()
        if value in {"preference", "project", "fact", "contact", "constraint"}:
            return cls.SEMANTIC
        if value == "procedure":
            return cls.PROCEDURAL
        if value in {"relationship", "relation"}:
            return cls.RELATIONSHIP
        return cls.SEMANTIC


class MemoryPriority(StrEnum):
    CRITICAL = "critical"  # importance >= 0.8 — identity/relationships/contacts
    IMPORTANT = "important"  # importance >= 0.6
    NORMAL = "normal"  # importance >= 0.4
    LOW = "low"  # importance >= 0.25
    TRANSIENT = "transient"  # everything below — the first to be forgotten

    @classmethod
    def from_importance(cls, importance: float) -> MemoryPriority:
        if importance >= 0.8:
            return cls.CRITICAL
        if importance >= 0.6:
            return cls.IMPORTANT
        if importance >= 0.4:
            return cls.NORMAL
        if importance >= 0.25:
            return cls.LOW
        return cls.TRANSIENT


class MemorySource(StrEnum):
    USER = "user"
    SYSTEM = "system"
    CONVERSATION = "conversation"
    DOCUMENT = "document"
    WEB = "web"


@dataclass
class RelationshipLink:
    """A typed connection between a memory (or entity) and another."""

    target: str  # memory id or entity name
    rel_type: str = "RELATED_TO"
    confidence: float = 0.8
    description: str = ""


@dataclass
class Memory:
    """Canonical memory object flowing through the agent lifecycle.

    Embeds the human-memory attributes that matter for management: importance
    (how critical it is), recency/usage (how freshly it is recalled), a TTL
    (forgetting horizon), and graph relationships (what it connects to).
    """

    id: str
    user_id: str
    type: MemoryType
    content: str
    importance: float = 0.5
    embedding: list[float] | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    source: MemorySource = MemorySource.CONVERSATION
    ttl_days: int | None = None
    access_count: int = 0
    last_accessed_at: datetime | None = None
    relationships: list[RelationshipLink] = field(default_factory=list)
    version: int = 1

    @property
    def priority(self) -> MemoryPriority:
        return MemoryPriority.from_importance(self.importance)

    @property
    def ttl(self) -> int:
        if self.ttl_days is not None:
            return self.ttl_days
        if self.importance >= 0.8:
            return 365
        if self.importance >= 0.6:
            return 180
        if self.importance >= 0.4:
            return 90
        return 30

    def to_graph_properties(self) -> dict[str, Any]:
        """Node properties for the Neo4j store."""
        return {
            "id": self.id,
            "user_id": self.user_id,
            "type": self.type.value,
            "content": self.content,
            "importance": self.importance,
            "source": self.source.value,
            "created_at": self.created_at.isoformat(),
            "access_count": self.access_count,
        }
