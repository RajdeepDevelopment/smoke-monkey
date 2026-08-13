"""MemoryAgent — orchestrates the write and read paths across both stores.

Write path (``index_exchange``): delegates the durable storage to the pgvector
``MemoryStore``, then — when the graph layer is enabled — mirrors each stored
fact as a graph node and links relationship edges reported by the extractor
(the relationship links become typed ``(subject)-[PREDICATE]->(object)`` edges
after each entity is resolved to an existing memory id).

Read path (``graph_context``): given the semantic/relationship hits the vector
store already found, walk the graph around those seeds and surface *connected*
memories the query never mentioned, formatted as relationship lines for the
system prompt.

The agent is defensive throughout: graph failures degrade to no-ops so memory
writes and reads stay best-effort (they must never break the pipeline).
"""
from __future__ import annotations

import logging
from typing import Any

from src.application.mem.classifier import MemoryClassifier
from src.application.mem.graph import GraphMemoryStore
from src.application.mem.models import Memory, MemorySource, MemoryType
from src.application.memory import MemoryStore, _embed_input_type
from src.config import settings
from src.generation.embedders import Embedder

logger = logging.getLogger(__name__)


class MemoryAgent:
    """Ties the pgvector store, the graph store, and classification together."""

    def __init__(
        self,
        store: MemoryStore,
        graph: GraphMemoryStore | None = None,
        embedder: Embedder | None = None,
    ) -> None:
        self.store = store
        self.graph = graph
        self.embedder = embedder
        self.classifier = MemoryClassifier()

    @property
    def graph_enabled(self) -> bool:
        return bool(
            self.graph is not None
            and self.graph.enabled
            and settings.memory_graph_enabled
        )

    # ── write path ──────────────────────────────────────────────────────────

    async def index_exchange(
        self,
        *,
        llm,
        user_id: str,
        conversation_id: str | None,
        query: str,
        answer: str,
        history: list[dict[str, str]] | None = None,
        embed_key: str | None = None,
        chat_key: str | None = None,
    ) -> None:
        """Persist one exchange: episodic + facts in pgvector, then graph links."""
        if self.store is None or not user_id:
            return
        records = await self.store.remember(
            llm=llm,
            user_id=user_id,
            conversation_id=conversation_id,
            query=query,
            answer=answer,
            history=history,
            embed_key=embed_key,
            chat_key=chat_key,
        )
        if not self.graph_enabled or not records:
            return
        try:
            await self._link_graph(user_id, records, embed_key)
        except Exception:
            logger.warning("graph memory linking failed", exc_info=True)

    async def _link_graph(
        self,
        user_id: str,
        records: list[dict[str, Any]],
        embed_key: str | None,
    ) -> None:
        graph = self.graph
        if not records or graph is None or not graph.enabled or not settings.memory_graph_enabled:
            return
        await graph.upsert_user(user_id)
        seen: set[str] = set()
        for record in records:
            fact = record.get("fact") or {}
            memory_id = str(record.get("memory_id") or "")
            if not memory_id or memory_id in seen:
                continue
            seen.add(memory_id)
            content = str(fact.get("content") or "").strip()
            if not content:
                continue
            mem_type = MemoryType.from_extractor(fact.get("type") or "fact")
            memory = Memory(
                id=memory_id,
                user_id=user_id,
                type=mem_type,
                content=content,
                importance=float(fact.get("importance") or 0.5),
                source=MemorySource.CONVERSATION,
            )
            await graph.upsert_memory(memory)

            for link in self.classifier.relationship_links(fact, fallback_subject=content):
                subject_id = await self._resolve_entity(user_id, link["subject"], embed_key)
                object_id = await self._resolve_entity(user_id, link["object"], embed_key)
                if subject_id and object_id and subject_id != object_id:
                    await graph.link_related(
                        subject_id,
                        object_id,
                        link["predicate"],
                        {"confidence": 0.8, "source": "extractor"},
                    )
                # Anchor the fact itself to both endpoints so it is reachable.
                if subject_id and subject_id != memory_id:
                    await graph.link_related(memory_id, subject_id, "RELATED_TO", {"confidence": 0.7})
                if object_id and object_id != memory_id:
                    await graph.link_related(memory_id, object_id, "RELATED_TO", {"confidence": 0.7})

    async def _resolve_entity(
        self,
        user_id: str,
        entity: str,
        embed_key: str | None,
    ) -> str | None:
        """Resolve a bare entity name to an existing memory id (or None).

        Tries a keyword match in the graph first (cheap, precise), then falls
        back to an embedding nearest-neighbor search in the vector store when
        the graph does not already hold the entity.
        """
        entity = (entity or "").strip().strip('"').strip()
        if not entity or len(entity) < 2:
            return None
        graph = self.graph
        if graph is not None and graph.enabled and settings.memory_graph_enabled:
            try:
                rows = await graph.find_related_by_content(user_id, entity, top_k=1)
                if rows and rows[0].get("id"):
                    return str(rows[0]["id"])
            except Exception:
                logger.debug("graph entity resolve failed", exc_info=True)
        if self.store is None or self.embedder is None:
            return None
        try:
            vectors = await self.embedder.embed(
                [entity],
                api_key=embed_key,
                input_type=_embed_input_type(self.embedder.provider_id),
            )
            if not vectors or not vectors[0]:
                return None
            matches = await self.store.match_entity(vectors[0], user_id, top_k=1)
        except Exception:
            logger.debug("embedding entity resolve failed", exc_info=True)
            return None
        if not matches:
            return None
        # Mirror the matched memory as a node so the edge can actually be created.
        if graph is not None:
            try:
                await graph.upsert_memory(
                    Memory(
                        id=matches[0]["id"],
                        user_id=user_id,
                        type=MemoryType.from_extractor(matches[0].get("type") or "fact"),
                        content=matches[0].get("content") or entity,
                        importance=float(matches[0].get("sim") or 0.5),
                        source=MemorySource.CONVERSATION,
                    )
                )
            except Exception:
                logger.debug("graph entity node upsert failed", exc_info=True)
        return matches[0]["id"]

    # ── read path ───────────────────────────────────────────────────────────

    async def graph_context(
        self,
        user_id: str,
        seed_ids: list[str],
        *,
        depth: int = 1,
        top_k: int = 6,
    ) -> list[str]:
        """Return prompt-ready relationship lines for memories connected to seeds."""
        graph = self.graph
        if not self.graph_enabled or not seed_ids or graph is None:
            return []
        try:
            rows = await graph.find_related_memories(user_id, seed_ids, depth=depth, top_k=top_k)
            return await graph.format_relationships(rows)
        except Exception:
            logger.debug("graph context failed", exc_info=True)
            return []
        try:
            rows = await self.graph.find_related_memories(user_id, seed_ids, depth=depth, top_k=top_k)
            return await self.graph.format_relationships(rows)
        except Exception:
            logger.debug("graph context failed", exc_info=True)
            return []
