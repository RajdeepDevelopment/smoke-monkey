"""Neo4j graph store for relationship memory (human-association layer).

Memories are nodes (``Memory``), keyed by the same id as the pgvector row, and
the user owns them via ``HAS_MEMORY`` edges. Typed edges between memories
(RELATED_TO, WORKS_AT, PREFERS, REPORTS_TO, ...) are created by the memory agent
when the extractor reports relationships, and retrieval walks the graph around
the semantic hits to surface *connected* memories the query never mentioned.

The driver is injectable so tests never need a live Neo4j instance. Every
method is defensive: a down/absent graph degrades to a no-op instead of
breaking the pipeline (memory must stay best-effort).
"""
from __future__ import annotations

import logging
import re
from typing import Any

from src.application.mem.models import Memory

logger = logging.getLogger(__name__)

# Relationship types the agent may create between memories. Sanitized before
# interpolation into Cypher (Neo4j relationship types cannot be parameterized).
_REL_TYPES = {
    "RELATED_TO",
    "WORKS_AT",
    "WORKS_WITH",
    "WORKS_FOR",
    "REPORTS_TO",
    "MANAGES",
    "MENTORS",
    "COLLABORATES_WITH",
    "PREFERS",
    "OWNS",
    "USES",
    "PART_OF",
    "SIMILAR_TO",
    "DEPENDS_ON",
    "CAUSES",
    "CONTRIBUTES_TO",
    "KNOWS",
    "TEACHES",
    "LEADS",
    "FAMILY_OF",
    "FRIEND_OF",
    "COLLEAGUE_OF",
    "HAS_MEMORY",
}

_SAFE_REL = re.compile(r"^[A-Z][A-Z0-9_]*$")

_CREATE_INDEXES = (
    "CREATE INDEX memory_node_id IF NOT EXISTS FOR (m:Memory) ON (m.id)",
    "CREATE INDEX memory_node_user IF NOT EXISTS FOR (m:Memory) ON (m.user_id)",
    "CREATE INDEX user_node_id IF NOT EXISTS FOR (u:User) ON (u.id)",
)


def sanitize_rel_type(rel_type: str) -> str:
    """Return a safe, known relationship type (or RELATED_TO)."""
    cleaned = re.sub(r"[^A-Z0-9_]", "_", (rel_type or "").strip().upper())
    if cleaned in _REL_TYPES or _SAFE_REL.match(cleaned):
        return cleaned
    return "RELATED_TO"


class GraphMemoryStore:
    """Async Neo4j storage. ``driver`` may be injected for tests."""

    def __init__(
        self,
        uri: str = "bolt://localhost:7687",
        user: str = "neo4j",
        password: str = "",
        driver: Any | None = None,
    ) -> None:
        self.uri = uri
        self.user = user
        self.password = password
        self._driver = driver

    @property
    def enabled(self) -> bool:
        return self._driver is not None

    async def connect(self) -> None:
        """Create the driver (idempotent). Does not ping the server."""
        if self._driver is not None:
            return
        try:
            from neo4j import AsyncGraphDatabase
        except ImportError:
            logger.warning("neo4j package not installed; graph memory disabled")
            self._driver = None
            return
        self._driver = AsyncGraphDatabase.driver(self.uri, auth=(self.user, self.password))

    async def close(self) -> None:
        if self._driver is None:
            return
        try:
            await self._driver.close()
        except Exception as exc:  # noqa: BLE001 - best-effort shutdown
            logger.debug("graph driver close failed: %s", exc)
        self._driver = None

    async def ensure_schema(self) -> None:
        if not self.enabled:
            return
        try:
            async with self._driver.session() as session:
                for statement in _CREATE_INDEXES:
                    await session.run(statement)
        except Exception as exc:  # noqa: BLE001
            logger.warning("graph schema setup failed (continuing): %s", exc)

    async def upsert_user(self, user_id: str) -> None:
        if not self.enabled:
            return
        try:
            async with self._driver.session() as session:
                await session.run("MERGE (u:User {id: $id})", id=user_id)
        except Exception as exc:  # noqa: BLE001
            logger.debug("graph upsert_user failed: %s", exc)

    async def upsert_memory(self, memory: Memory) -> None:
        if not self.enabled:
            return
        props = memory.to_graph_properties()
        try:
            async with self._driver.session() as session:
                await session.run(
                    """
                    MERGE (m:Memory {id: $id})
                    SET m += $props
                    """,
                    id=memory.id,
                    props=props,
                )
                await session.run(
                    """
                    MATCH (u:User {id: $user_id}), (m:Memory {id: $id})
                    MERGE (u)-[:HAS_MEMORY]->(m)
                    """,
                    user_id=memory.user_id,
                    id=memory.id,
                )
        except Exception as exc:  # noqa: BLE001
            logger.debug("graph upsert_memory failed: %s", exc)

    async def link_related(
        self,
        from_id: str,
        to_id: str,
        rel_type: str = "RELATED_TO",
        properties: dict[str, Any] | None = None,
    ) -> None:
        """Create/refresh a typed edge between two memories (both must exist)."""
        if not self.enabled:
            return
        rel = sanitize_rel_type(rel_type)
        try:
            async with self._driver.session() as session:
                await session.run(
                    f"""
                    MATCH (a:Memory {{id: $from_id}}), (b:Memory {{id: $to_id}})
                    MERGE (a)-[r:{rel}]->(b)
                    SET r += $props
                    """,
                    from_id=from_id,
                    to_id=to_id,
                    props=properties or {},
                )
        except Exception as exc:  # noqa: BLE001
            logger.debug("graph link_related failed: %s", exc)

    async def find_related_memories(
        self,
        user_id: str,
        seed_ids: list[str],
        *,
        depth: int = 1,
        top_k: int = 6,
    ) -> list[dict[str, Any]]:
        """Walk the graph around the seed memories and return related memories.

        Returns rows with ``id, content, type, importance, rel_type`` (the edge
        type that connected them). The graph is scoped to the user.
        """
        if not self.enabled or not seed_ids:
            return []
        depth = max(1, int(depth))
        try:
            async with self._driver.session() as session:
                result = await session.run(
                    """
                    MATCH (u:User {id: $user_id})-[:HAS_MEMORY]->(seed:Memory)
                    WHERE seed.id IN $seed_ids
                    MATCH (seed)-[r]-(related:Memory)
                    WHERE related.id <> seed.id
                      AND related.user_id = $user_id
                    WITH related, type(r) AS rel_type, r.confidence AS conf
                    RETURN related.id AS id, related.content AS content,
                           related.type AS type, related.importance AS importance,
                           rel_type, coalesce(conf, 0.8) AS confidence
                    ORDER BY related.importance DESC
                    LIMIT $top_k
                    """,
                    user_id=user_id,
                    seed_ids=list(seed_ids),
                    top_k=top_k,
                )
                return [dict(record) async for record in result]
        except Exception as exc:  # noqa: BLE001 - graph is best-effort
            logger.debug("graph find_related_memories failed: %s", exc)
            return []

    async def find_related_by_content(
        self,
        user_id: str,
        content: str,
        *,
        top_k: int = 3,
    ) -> list[dict[str, Any]]:
        """Find memories mentioning an entity (used to resolve relationship
        subjects/objects to existing memories)."""
        if not self.enabled or not content:
            return []
        try:
            async with self._driver.session() as session:
                result = await session.run(
                    """
                    MATCH (m:Memory {user_id: $user_id})
                    WHERE toLower(m.content) CONTAINS toLower($content)
                    RETURN m.id AS id, m.content AS content, m.importance AS importance
                    ORDER BY m.importance DESC
                    LIMIT $top_k
                    """,
                    user_id=user_id,
                    content=content,
                    top_k=top_k,
                )
                return [dict(record) async for record in result]
        except Exception as exc:  # noqa: BLE001
            logger.debug("graph find_related_by_content failed: %s", exc)
            return []

    async def prune_stale_edges(self, user_id: str, active_ids: list[str]) -> None:
        """Remove edges from deleted/expired memories (called on consolidation)."""
        if not self.enabled:
            return
        try:
            async with self._driver.session() as session:
                await session.run(
                    """
                    MATCH (u:User {id: $user_id})-[r:HAS_MEMORY]->(m:Memory)
                    WHERE NOT m.id IN $active_ids
                    DETACH DELETE m
                    """,
                    user_id=user_id,
                    active_ids=list(active_ids),
                )
        except Exception as exc:  # noqa: BLE001
            logger.debug("graph prune_stale_edges failed: %s", exc)

    async def format_relationships(self, related: list[dict[str, Any]]) -> list[str]:
        """Render graph rows into prompt-friendly relationship lines."""
        lines: list[str] = []
        for row in related:
            content = str(row.get("content") or "").strip()
            rel_type = str(row.get("rel_type") or "RELATED_TO")
            importance = float(row.get("importance") or 0.5)
            if not content:
                continue
            lines.append(f"[{rel_type}, importance {importance:.1f}] {content}")
        return lines


# Re-export for convenience (relationship types registry).
RELATIONSHIP_TYPES = sorted(_REL_TYPES)
