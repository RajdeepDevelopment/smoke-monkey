"""Super memory: pgvector-backed conversation + user-profile memory.

Two layers, both keyed by user:

1. ``conversation_memory`` — every user/assistant message is embedded and
   stored, so a future question ("what did we decide about OpenSearch?") can
   be answered from *this* user's own history.
2. ``memories`` — durable facts (preferences, projects, constraints) extracted
   by the LLM from each exchange, giving the assistant a long-term user profile.

Writes are fire-and-forget: ``index_exchange`` is scheduled after a streamed
answer and must never block or break the response. All failures are swallowed
and logged at debug level.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import re
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from src.config import settings
from src.domain import MemoryFact, MemoryHit
from src.generation.embedders import Embedder
from src.generation.prompts import (
    memory_extract_payload,
    memory_extract_prompt,
    memory_extract_system,
)

logger = logging.getLogger(__name__)

_STRICT_JSON_PROMPT = """CRITICAL OUTPUT FORMAT INSTRUCTION: Reply with ONLY a
valid JSON array of objects. No prose, no reasoning, no explanation, no
markdown, no code fences. The very first character of your reply MUST be '['.
Example: [{"type": "fact", "content": "...", "importance": 0.9}]
"""

_MEMORY_QUERY = """
SELECT id, conversation_id, role, content, created_at, access_count, last_accessed_at,
       1 - (embedding <=> $1::vector) AS score
FROM conversation_memory
WHERE user_id = $2::uuid AND embedding IS NOT NULL
  AND (expires_at IS NULL OR expires_at > now())
ORDER BY embedding <=> $1::vector
LIMIT $3
"""

_FACTS_QUERY = """
SELECT id, type, content, importance, created_at, access_count, last_accessed_at,
       1 - (embedding <=> $1::vector) AS score
FROM memories
WHERE user_id = $2::uuid AND embedding IS NOT NULL
  AND (expires_at IS NULL OR expires_at > now())
ORDER BY embedding <=> $1::vector
LIMIT $3
"""

_DEDUPE_QUERY = """
SELECT id, content, importance, 1 - (embedding <=> $1::vector) AS sim
FROM memories
WHERE user_id = $2::uuid AND embedding IS NOT NULL
ORDER BY embedding <=> $1::vector
LIMIT 1
"""

_FACT_UPDATE = """
UPDATE memories
SET importance = GREATEST(importance, $2),
    content = $3,
    last_accessed_at = now()
WHERE id = $1
RETURNING id
"""

_FACT_INSERT = """
INSERT INTO memories
    (user_id, type, content, embedding, importance, source_message, expires_at)
VALUES ($1::uuid, $2, $3, $4::vector, $5, $6, now() + $7 * INTERVAL '1 day')
RETURNING id
"""

_RELATIONSHIP_QUERY = """
SELECT id, type, content, importance, created_at, access_count, last_accessed_at,
       1 - (embedding <=> $1::vector) AS score
FROM memories
WHERE user_id = $2::uuid AND type = 'relationship' AND embedding IS NOT NULL
  AND (expires_at IS NULL OR expires_at > now())
ORDER BY embedding <=> $1::vector
LIMIT $3
"""

_ENTITY_MATCH_QUERY = """
SELECT id, type, content, 1 - (embedding <=> $1::vector) AS sim
FROM memories
WHERE user_id = $2::uuid AND embedding IS NOT NULL
ORDER BY embedding <=> $1::vector
LIMIT $3
"""


def _vec(value: list[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in value) + "]"


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _extract_json_array(raw: str) -> list[dict[str, Any]] | None:
    """Pull the first JSON array out of an LLM reply (tolerates prose/fences).

    Tries, in order:
    1. a clean JSON array,
    2. the outermost ``[...]`` span (ignores trailing commas),
    3. a regex-scan for a ``[{...}]`` array buried inside reasoning prose
       (e.g. a model that narrates before emitting the payload).
    """
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.IGNORECASE | re.DOTALL)
    raw = raw.strip()
    if not raw:
        return None

    candidates: list[str] = []
    if raw.startswith("["):
        candidates.append(raw)
    start = raw.find("[")
    end = raw.rfind("]")
    if start != -1 and end > start:
        candidates.append(raw[start : end + 1])
    candidates.append(_prose_scan(raw))

    for candidate in candidates:
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            parsed = _repair_json(candidate)
        if isinstance(parsed, list):
            return parsed
    return None


def _prose_scan(raw: str) -> str | None:
    """Locate a JSON array within free text using a tolerant regex."""
    match = re.search(r"\[\s*\{.*?\}\]", raw, flags=re.DOTALL)
    return match.group(0) if match else None


def _repair_json(candidate: str) -> Any:
    """Second-chance parse for trailing commas / wrapped objects."""
    try:
        candidate = re.sub(r",\s*([}\]])", r"\1", candidate)
        return json.loads(candidate)
    except json.JSONDecodeError:
        return None


def _embed_input_type(provider_id: str) -> str | None:
    if provider_id == "nvidia":
        return settings.nvidia_embed_input_type
    if provider_id == "openrouter":
        return settings.openrouter_embed_input_type
    return None


# ── Memory Ranker (spec: Memory Ranker, "smart filtering") ─────────────────

def _recency_score(
    created_at: datetime | None,
    last_accessed_at: datetime | None,
    half_life_hours: float,
    now: datetime,
) -> float:
    """Human forgetting curve: recency = 2 ** (-age_hours / half_life).

    The age is measured from the LAST time the memory was used (recalled or
    restated), not from creation. Every recall resets the freshness clock —
    that is how human reconsolidation works: a memory touched recently feels
    fresh no matter how old it is, and an untouched memory fades with time.
    """
    anchor = last_accessed_at or created_at
    if anchor is None:
        return 0.5
    age_hours = max(0.0, (now - anchor).total_seconds() / 3600)
    return 2.0 ** (-age_hours / half_life_hours)


def _frequency_score(access_count: int) -> float:
    """Log-scaled access frequency in [0, 1] (10+ accesses saturates)."""
    return min(1.0, math.log(max(access_count, 0) + 1) / math.log(10))


def _context_score(query: str, content: str) -> float:
    """Fraction of the query's significant tokens that appear in the memory."""
    query_tokens = {w for w in re.findall(r"[a-z0-9]{3,}", query.lower())}
    if not query_tokens:
        return 0.0
    content_tokens = {w for w in re.findall(r"[a-z0-9]{3,}", content.lower())}
    return min(1.0, len(query_tokens & content_tokens) / len(query_tokens))


def rank_memory(
    items: list[MemoryHit | MemoryFact] | Sequence[MemoryHit] | Sequence[MemoryFact],
    query: str,
    *,
    now: datetime | None = None,
) -> list[Any]:
    """Re-rank already semantic-filtered memories with the weighted score:

    score = semantic*w_sem + recency*w_rec + frequency*w_freq
          + context*w_ctx + importance*w_imp

    Importance is part of the blend so that high-value durable facts (manager,
    contacts, company, identity) rank above trivia even when the query only
    loosely matches them. Conversation hits have no importance and default to
    0.5 (neutral). Returns the items in descending blended order (caller slices
    top-K).
    """
    weights = (
        settings.memory_weight_semantic,
        settings.memory_weight_recency,
        settings.memory_weight_frequency,
        settings.memory_weight_context,
        settings.memory_weight_importance,
    )
    now = now or datetime.now(UTC)
    scored: list[tuple[float, MemoryHit | MemoryFact]] = []
    for item in items:
        importance = getattr(item, "importance", 0.5)
        blended = (
            weights[0] * item.score
            + weights[1]
            * _recency_score(
                item.created_at,
                getattr(item, "last_accessed_at", None),
                settings.memory_recency_half_life_hours,
                now,
            )
            + weights[2] * _frequency_score(item.access_count)
            + weights[3] * _context_score(query, item.content)
            + weights[4] * importance
        )
        scored.append((blended, item))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [item for _, item in scored]


def _ttl_days(importance: float) -> int:
    """Priority → TTL tier (spec: Memory Scorer): critical facts live a year,
    important ones 6 months, normal 3 months, transient a month."""
    if importance >= 0.8:
        return 365
    if importance >= 0.6:
        return 180
    if importance >= 0.4:
        return 90
    return 30


class MemoryStore:
    def __init__(self, pool, embedder: Embedder) -> None:
        self.pool = pool
        self.embedder = embedder

    # ── schema ──────────────────────────────────────────────────────────────

    async def ensure_schema(self) -> None:
        dims = self.embedder.dims
        memory_ddl = f"""
        CREATE TABLE IF NOT EXISTS conversation_memory (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         UUID NOT NULL,
            conversation_id UUID,
            role            TEXT NOT NULL,
            content         TEXT NOT NULL,
            content_hash    TEXT NOT NULL,
            embedding       vector({dims}),
            access_count    INTEGER NOT NULL DEFAULT 0,
            last_accessed_at TIMESTAMPTZ,
            expires_at      TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (user_id, content_hash)
        )
        """
        facts_ddl = f"""
        CREATE TABLE IF NOT EXISTS memories (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         UUID NOT NULL,
            type            TEXT NOT NULL,
            content         TEXT NOT NULL,
            embedding       vector({dims}),
            importance      DOUBLE PRECISION NOT NULL DEFAULT 0.5,
            source_message  TEXT,
            access_count    INTEGER NOT NULL DEFAULT 0,
            last_accessed_at TIMESTAMPTZ,
            expires_at      TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
        statements = [
            memory_ddl,
            facts_ddl,
            # Migrations for databases created before the ranker/TTL columns.
            "ALTER TABLE conversation_memory ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE conversation_memory ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ",
            "ALTER TABLE conversation_memory ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ",
            "ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ",
            "ALTER TABLE memories ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ",
            "CREATE INDEX IF NOT EXISTS idx_memory_user ON conversation_memory (user_id)",
            "CREATE INDEX IF NOT EXISTS idx_memory_hash ON conversation_memory (content_hash)",
            "CREATE INDEX IF NOT EXISTS idx_memories_user ON memories (user_id)",
        ]
        # pgvector's HNSW is capped at 2000 dims; higher-dim embeddings scan.
        if dims <= 2000:
            statements.append(
                "CREATE INDEX IF NOT EXISTS idx_memory_hnsw "
                "ON conversation_memory USING hnsw (embedding vector_cosine_ops)"
            )
            statements.append(
                "CREATE INDEX IF NOT EXISTS idx_memories_hnsw "
                "ON memories USING hnsw (embedding vector_cosine_ops)"
            )
        async with self.pool.acquire() as conn:
            for statement in statements:
                await conn.execute(statement)

    # ── search ──────────────────────────────────────────────────────────────

    async def search_conversation(
        self,
        query_vector: list[float],
        user_id: str,
        top_k: int,
    ) -> list[MemoryHit]:
        rows = await self.pool.fetch(_MEMORY_QUERY, _vec(query_vector), user_id, top_k)
        hits: list[MemoryHit] = []
        for row in rows:
            score = max(float(row["score"] or 0), 0.0)
            if score <= 0:
                continue
            hits.append(
                MemoryHit(
                    id=str(row["id"]),
                    conversation_id=str(row["conversation_id"]) if row["conversation_id"] else None,
                    role=row["role"],
                    content=row["content"],
                    score=score,
                    created_at=row["created_at"],
                    access_count=int(row["access_count"] or 0),
                    last_accessed_at=row["last_accessed_at"],
                )
            )
        return hits

    async def search_facts(
        self,
        query_vector: list[float],
        user_id: str,
        top_k: int,
    ) -> list[MemoryFact]:
        rows = await self.pool.fetch(_FACTS_QUERY, _vec(query_vector), user_id, top_k)
        facts: list[MemoryFact] = []
        for row in rows:
            score = max(float(row["score"] or 0), 0.0)
            if score <= 0:
                continue
            facts.append(
                MemoryFact(
                    id=str(row["id"]),
                    type=row["type"],
                    content=row["content"],
                    importance=float(row["importance"] or 0.5),
                    score=score,
                    created_at=row["created_at"],
                    access_count=int(row["access_count"] or 0),
                    last_accessed_at=row["last_accessed_at"],
                )
            )
        return facts

    async def search_critical_facts(self, user_id: str, min_importance: float, top_k: int) -> list[MemoryFact]:
        """Recall the user's most important durable facts regardless of query.

        This is the "critical-facts floor": identity and relationship facts the
        user has marked high-value (manager, contacts, company, family, ...) are
        always candidates so they can never be starved out by a query that
        happens to match trivia more closely.
        """
        if top_k <= 0:
            return []
        rows = await self.pool.fetch(
            """
            SELECT id, type, content, importance, created_at, access_count,
                   last_accessed_at, 1.0 AS score
            FROM memories
            WHERE user_id = $1::uuid
              AND importance >= $2
              AND (expires_at IS NULL OR expires_at > now())
            ORDER BY importance DESC, created_at DESC
            LIMIT $3
            """,
            user_id,
            min_importance,
            top_k,
        )
        return [
            MemoryFact(
                id=str(row["id"]),
                type=row["type"],
                content=row["content"],
                importance=float(row["importance"] or 0.5),
                score=float(row["score"] or 1.0),
                created_at=row["created_at"],
                access_count=int(row["access_count"] or 0),
                last_accessed_at=row["last_accessed_at"],
            )
            for row in rows
        ]

    # ── write path (fire-and-forget) ────────────────────────────────────────

    async def remember(
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
    ) -> list[dict[str, Any]]:
        """Store one exchange (episodic + facts) and return the stored fact records.

        Each record is ``{"fact": {...}, "memory_id": str, "user_id": str}`` so the
        graph layer can upsert matching nodes and link relationship edges without
        re-reading the vector store.
        """
        if not user_id:
            return []
        try:
            await self._store_messages(user_id, conversation_id, query, answer, embed_key)
        except Exception:
            logger.warning("message memory write failed", exc_info=True)

        stored: list[dict[str, Any]] = []
        if settings.memory_extract_enabled and answer:
            try:
                stored = await self._extract_and_store(
                    llm, user_id, query, answer, history or [], embed_key, chat_key
                )
            except Exception:
                logger.warning("fact memory write failed", exc_info=True)
        return stored

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
        await self.remember(
            llm=llm,
            user_id=user_id,
            conversation_id=conversation_id,
            query=query,
            answer=answer,
            history=history,
            embed_key=embed_key,
            chat_key=chat_key,
        )

    async def search_relationships(
        self,
        query_vector: list[float],
        user_id: str,
        top_k: int,
    ) -> list[MemoryFact]:
        rows = await self.pool.fetch(_RELATIONSHIP_QUERY, _vec(query_vector), user_id, top_k)
        facts: list[MemoryFact] = []
        for row in rows:
            score = max(float(row["score"] or 0), 0.0)
            if score <= 0:
                continue
            facts.append(
                MemoryFact(
                    id=str(row["id"]),
                    type=row["type"],
                    content=row["content"],
                    importance=float(row["importance"] or 0.5),
                    score=score,
                    created_at=row["created_at"],
                    access_count=int(row["access_count"] or 0),
                    last_accessed_at=row["last_accessed_at"],
                )
            )
        return facts

    async def match_entity(
        self,
        vector: list[float],
        user_id: str,
        top_k: int = 1,
        min_score: float | None = None,
    ) -> list[dict[str, Any]]:
        """Resolve a bare entity string to an existing memory node id."""
        threshold = settings.memory_graph_match_threshold if min_score is None else min_score
        rows = await self.pool.fetch(_ENTITY_MATCH_QUERY, _vec(vector), user_id, top_k)
        matches: list[dict[str, Any]] = []
        for row in rows:
            sim = max(float(row["sim"] or 0), 0.0)
            if sim >= threshold:
                matches.append(
                    {
                        "id": str(row["id"]),
                        "content": row["content"],
                        "type": row["type"],
                        "sim": sim,
                    }
                )
        return matches

    async def _store_messages(
        self,
        user_id: str,
        conversation_id: str | None,
        query: str,
        answer: str,
        embed_key: str | None,
    ) -> None:
        texts = [t for t in (query, answer) if t and t.strip()]
        if not texts:
            return
        vectors = await self.embedder.embed(
            texts,
            api_key=embed_key,
            input_type=_embed_input_type(self.embedder.provider_id),
        )
        insert = """
        INSERT INTO conversation_memory
            (user_id, conversation_id, role, content, content_hash, embedding)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::vector)
        ON CONFLICT (user_id, content_hash) DO NOTHING
        """
        async with self.pool.acquire() as conn:
            for text, vector in zip(texts, vectors, strict=False):
                if not vector:
                    continue
                await conn.execute(
                    insert,
                    user_id,
                    conversation_id,
                    "user" if text == query else "assistant",
                    text,
                    _hash(text),
                    _vec(vector),
                )

    async def _extract_and_store(
        self,
        llm,
        user_id: str,
        query: str,
        answer: str,
        history: list[dict[str, str]],
        embed_key: str | None,
        chat_key: str | None,
    ) -> list[dict[str, Any]]:
        facts = await self._extract_facts(llm, query, answer, history, chat_key)
        if not facts:
            return []
        texts = [f["content"] for f in facts]
        vectors = await self.embedder.embed(
            texts,
            api_key=embed_key,
            input_type=_embed_input_type(self.embedder.provider_id),
        )
        # Spec write pipeline: Classifier → Deduplicator → Resolver → Validator
        # → Scorer. Each candidate is compared against the user's existing
        # memories and either stored, merged into the best match, or skipped.
        # The resolved row ids are returned so the graph layer can link nodes.
        stored: list[dict[str, Any]] = []
        async with self.pool.acquire() as conn:
            for fact, vector in zip(facts, vectors, strict=False):
                if not vector:
                    continue
                memory_id = await self._upsert_fact(conn, user_id, fact, vector)
                if memory_id:
                    stored.append(
                        {
                            "fact": fact,
                            "memory_id": memory_id,
                            "user_id": user_id,
                        }
                    )
        return stored

    async def _upsert_fact(
        self,
        conn,
        user_id: str,
        fact: dict[str, Any],
        vector: list[float],
    ) -> str | None:
        row = await conn.fetchrow(_DEDUPE_QUERY, _vec(vector), user_id)
        sim = max(float(row["sim"] or 0), 0.0) if row else 0.0
        if sim >= settings.memory_dedupe_ignore:
            # Near-exact duplicate: skip the write, refresh recency/usage.
            await conn.execute(
                "UPDATE memories SET last_accessed_at = now(), access_count = access_count + 1 WHERE id = $1",
                row["id"],
            )
            return str(row["id"])
        if sim >= settings.memory_dedupe_merge:
            # Same concept stated again: merge (keep highest importance, latest text).
            updated = await conn.fetchrow(_FACT_UPDATE, row["id"], fact["importance"], fact["content"])
            return str(updated["id"])
        inserted = await conn.fetchrow(
            _FACT_INSERT,
            user_id,
            fact["type"],
            fact["content"],
            _vec(vector),
            fact["importance"],
            fact.get("source") or "",
            _ttl_days(fact["importance"]),
        )
        return str(inserted["id"])

    async def touch(self, memory_ids: list[uuid.UUID], fact_ids: list[uuid.UUID]) -> None:
        """Bump access stats for recalled memories (feeds the frequency signal).

        Human reconsolidation: every recall strengthens the memory. Facts get a
        small importance boost (capped at 1.0) so the memories the user actually
        relies on become more durable, while the ones they never use fade away
        via the consolidation pass.
        """
        if not memory_ids and not fact_ids:
            return
        async with self.pool.acquire() as conn:
            if memory_ids:
                await conn.execute(
                    "UPDATE conversation_memory SET access_count = access_count + 1, "
                    "last_accessed_at = now() WHERE id = ANY($1::uuid[])",
                    memory_ids,
                )
            if fact_ids:
                boost = settings.memory_reconsolidation_boost
                await conn.execute(
                    "UPDATE memories SET access_count = access_count + 1, "
                    "last_accessed_at = now(), "
                    "importance = LEAST(1.0, importance + $1::double precision) "
                    "WHERE id = ANY($2::uuid[])",
                    boost,
                    fact_ids,
                )

    async def consolidate(self) -> None:
        """Human-like consolidation pass (runs at startup).

        1. Purge expired facts and aged episodic memory.
        2. Forget: below-critical facts that have not been used within the
           grace window lose importance every day since the last recall; facts
           that fade below the forget floor are deleted.
        3. Merge: near-duplicate facts (the same concept restated across
           conversations) collapse into a single canonical memory.
        """
        if not settings.memory_consolidate_enabled:
            return
        async with self.pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < now()"
            )
            await conn.execute(
                "DELETE FROM conversation_memory "
                "WHERE created_at < now() - $1::int * INTERVAL '1 day'",
                settings.memory_episodic_retention_days,
            )
            # Forgetting curve: importance erodes with every day since the last
            # recall. Critical facts (identity, relationships, contacts) are
            # protected — they are the user's core profile.
            await conn.execute(
                """
                UPDATE memories
                SET importance = GREATEST(0.0,
                    importance - $1::double precision
                        * EXTRACT(epoch FROM (now() - COALESCE(last_accessed_at, created_at)))
                        / 86400.0)
                WHERE importance < $2::double precision
                  AND COALESCE(last_accessed_at, created_at)
                        < now() - $3::double precision * INTERVAL '1 day'
                """,
                settings.memory_decay_daily,
                settings.memory_critical_importance,
                settings.memory_decay_grace_days,
            )
            # Forget: drop memories that have faded below the recall floor.
            await conn.execute(
                "DELETE FROM memories WHERE importance < $1::double precision",
                settings.memory_forget_floor,
            )
        await self._merge_duplicate_facts()

    async def _merge_duplicate_facts(self) -> None:
        """Fold near-duplicate facts into a single canonical memory.

        Each fact is compared against the user's other memories; if the closest
        neighbour is close enough (>= ``memory_dedupe_merge``) the weaker copy
        (lower importance, or shorter text when equal) is deleted. High-value
        memories are processed first so the strongest variant survives.
        """
        async with self.pool.acquire() as conn:
            user_rows = await conn.fetch("SELECT DISTINCT user_id FROM memories")
            for user_row in user_rows:
                user_id = user_row["user_id"]
                facts = await conn.fetch(
                    "SELECT id, content, importance, embedding FROM memories "
                    "WHERE user_id = $1::uuid AND embedding IS NOT NULL "
                    "ORDER BY importance DESC, created_at DESC",
                    user_id,
                )
                for fact in facts:
                    embedding = fact["embedding"]
                    if isinstance(embedding, str):
                        embedding = [
                            float(x) for x in embedding.strip("[]").split(",") if x.strip()
                        ]
                    if not embedding:
                        continue
                    neighbor = await conn.fetchrow(
                        """
                        SELECT id, content, importance,
                               1 - (embedding <=> $3::vector) AS sim
                        FROM memories
                        WHERE user_id = $1::uuid AND embedding IS NOT NULL
                          AND id <> $2::uuid
                        ORDER BY embedding <=> $3::vector
                        LIMIT 1
                        """,
                        user_id,
                        fact["id"],
                        _vec(embedding),
                    )
                    if not neighbor:
                        continue
                    sim = max(float(neighbor["sim"] or 0), 0.0)
                    stronger = neighbor["importance"] > fact["importance"] or (
                        neighbor["importance"] == fact["importance"]
                        and len(str(neighbor["content"] or "")) >= len(str(fact["content"] or ""))
                    )
                    if sim >= settings.memory_dedupe_merge and stronger:
                        await conn.execute(
                            "DELETE FROM memories WHERE id = $1::uuid", fact["id"]
                        )

    async def _extract_facts(
        self,
        llm,
        query: str,
        answer: str,
        history: list[dict[str, str]],
        chat_key: str | None,
    ) -> list[dict[str, Any]]:
        parsed = await self._extract_with_retry(llm, query, answer, history, chat_key)
        if parsed is None:
            return []
        facts: list[dict[str, Any]] = []
        for item in parsed:
            if not isinstance(item, dict):
                continue
            content = str(item.get("content") or "").strip()
            if not content or len(content) > 1000:
                continue
            ftype = str(item.get("type") or "fact").strip().lower()
            if ftype not in {"preference", "project", "procedure", "fact"}:
                ftype = "fact"
            try:
                importance = min(max(float(item.get("importance", 0.5)), 0.0), 1.0)
            except (TypeError, ValueError):
                importance = 0.5
            if importance < settings.memory_extract_min_importance:
                continue
            fact: dict[str, Any] = {"type": ftype, "content": content, "importance": importance}
            if settings.memory_graph_enabled:
                links = item.get("relationships") or item.get("links")
                if isinstance(links, list):
                    fact["relationships"] = links
            facts.append(fact)
        return facts

    async def _extract_with_retry(
        self,
        llm,
        query: str,
        answer: str,
        history: list[dict[str, str]],
        chat_key: str | None,
    ) -> list[dict[str, Any]] | None:
        """Call the extractor, parsing the JSON payload with retries.

        Strategy (works across chat models with very different temperaments):
        1. Send the format contract as a *system* message and the conversation
           as the *user* message, with a generous token budget. System-role
           contracts are followed much more reliably than single-turn walls of
           text, and the narration some models produce first is given enough
           room to finish with the actual JSON payload.
        2. If that fails, retry as a single strict user turn.
        Cloud endpoints also throw spurious 4xx/5xx during load blips, so the
        attempts are retried with escalating backoff (extraction runs in the
        background, a few seconds of patience costs nothing). Only if everything
        fails do we surface a warning — the loss is visible, never silent.
        """
        attempts = (
            [
                {"role": "system", "content": memory_extract_system() + "\n\n" + _STRICT_JSON_PROMPT},
                {"role": "user", "content": memory_extract_payload(query, answer, history)},
            ],
            [
                {"role": "user", "content": _STRICT_JSON_PROMPT + "\n\n" + memory_extract_prompt(query, answer, history)},
            ],
        )
        backoff = (2.0, 6.0, 12.0)
        last_raw = ""
        for attempt in attempts:
            for wait in backoff:
                try:
                    raw = await self._complete_messages(llm, attempt, chat_key)
                except Exception as exc:  # noqa: BLE001 - upstream blips are transient
                    logger.debug("fact extraction attempt failed: %s (retrying in %.0fs)", exc, wait)
                    await asyncio.sleep(wait)
                    continue
                last_raw = raw or ""
                parsed = _extract_json_array(raw or "")
                if parsed is not None:
                    return parsed
                break
        logger.warning(
            "fact extraction returned unparseable output (%.0f chars, no facts stored): %s",
            len(last_raw),
            last_raw[:200].replace("\n", " "),
        )
        return None

    async def _complete_messages(
        self,
        llm,
        messages: list[dict[str, str]],
        chat_key: str | None,
    ) -> str:
        """Stream a chat completion and join the deltas (system+user aware)."""
        parts: list[str] = []
        async for delta in llm.chat_stream(
            messages,
            temperature=0.0,
            max_tokens=2000,
            api_key=chat_key,
        ):
            parts.append(delta)
        return "".join(parts)
