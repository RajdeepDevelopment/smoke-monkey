"""Retrieval planner: decides what the memory layer should pull for a query.

The pipeline already knows the routing decision (intent, needs_memory, ...).
The planner turns that into a concrete memory plan — which memory types to
fetch, how many of each, whether to include the critical-facts floor, and how
deeply to walk the relationship graph. This keeps the retrieval strategy data-
driven and per-query instead of one-size-fits-all.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from src.application.mem.models import MemoryType
from src.config import settings


@dataclass
class MemoryPlan:
    """A resolved retrieval plan for one query."""

    types: list[MemoryType]  # memory types to fetch (semantic/episodic/...)
    semantic_top_k: int = 5
    episodic_top_k: int = 4
    include_critical: bool = True
    critical_importance: float = 0.8
    critical_top_k: int = 3
    graph_depth: int = field(default_factory=lambda: settings.memory_graph_context_depth)
    graph_context_top_k: int = field(default_factory=lambda: settings.memory_graph_context_top_k)
    reasoning: str = ""


class RetrievalPlanner:
    """Create a memory plan from the routing decision + query signals."""

    @staticmethod
    def create_plan(
        *,
        intent: str = "general",
        needs_memory: bool = False,
        query: str = "",
        route: str = "complex",
    ) -> MemoryPlan:
        intent = (intent or "general").lower().strip()
        query_lower = query.lower()
        mentions_time = any(
            w in query_lower for w in ("today", "yesterday", "last week", "earlier", "recently", "before")
        )

        # A memory-heavy query: the user asks about their own past/work.
        if intent in ("memory", "hybrid") or needs_memory:
            return MemoryPlan(
                types=[MemoryType.SEMANTIC, MemoryType.EPISODIC, MemoryType.PROCEDURAL, MemoryType.RELATIONSHIP],
                semantic_top_k=6,
                episodic_top_k=5,
                include_critical=True,
                graph_depth=2,
                graph_context_top_k=8,
                reasoning="personal/continuity query → full memory recall + graph",
            )

        # Explicit question about relationships between people/topics.
        if any(w in query_lower for w in ("who is", "how are", "related", "connection", "relationship")):
            return MemoryPlan(
                types=[MemoryType.SEMANTIC, MemoryType.RELATIONSHIP],
                semantic_top_k=5,
                include_critical=True,
                graph_depth=2,
                graph_context_top_k=8,
                reasoning="relationship-focused query → semantic + graph walk",
            )

        # A fresh/current event reference favours episodic (working memory).
        if mentions_time:
            return MemoryPlan(
                types=[MemoryType.SEMANTIC, MemoryType.EPISODIC],
                episodic_top_k=4,
                include_critical=True,
                graph_depth=1,
                reasoning="time-anchored query → episodic + durable facts",
            )

        # Default: durable profile facts + critical floor (cheap, every turn).
        return MemoryPlan(
            types=[MemoryType.SEMANTIC],
            include_critical=True,
            graph_depth=1,
            reasoning="default → durable facts + critical floor",
        )
