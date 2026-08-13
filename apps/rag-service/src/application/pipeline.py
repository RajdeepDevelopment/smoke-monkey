"""End-to-end query pipeline orchestration (streams SSE events)."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any, cast

import asyncpg
from redis.asyncio import Redis

from src.application.cache import QueryCache
from src.application.mem.agent import MemoryAgent
from src.application.mem.models import MemoryType
from src.application.mem.planner import MemoryPlan, RetrievalPlanner
from src.application.memory import MemoryStore, rank_memory
from src.application.router import QueryRouter, RoutePlan, _fallback_plan
from src.application.telemetry import Telemetry
from src.application.websearch import WebSearchClient, format_web_result, web_search_enabled_for
from src.config import settings
from src.domain import MemoryFact, MemoryHit, QueryRequest, RetrievedChunk, RetrieveRequest
from src.generation import build_chat_llm, build_citations, build_system_prompt, compute_confidence
from src.generation.embedders import Embedder
from src.generation.llm import ChatLLM
from src.generation.prompts import (
    build_direct_prompt,
    groundedness_prompt,
    hyde_prompt,
    multi_query_prompt,
)
from src.keys import resolve_user_api_key
from src.retrieval import OpenRouterReranker, Reranker, dense_search, rrf_merge, sparse_search

logger = logging.getLogger(__name__)

PARENT_QUERY = "SELECT id, content FROM chunks WHERE id = ANY($1::uuid[])"

CLOUD_PROVIDERS = ("openrouter", "nvidia")

EMBED_CACHE_PREFIX = "rag:embed:v1"
RETRIEVAL_CACHE_PREFIX = "rag:retr:v1"

_QUERY_MARKERS = (
    "how",
    "what",
    "why",
    "where",
    "which",
    "who",
    "when",
    "compare",
    "explain",
    "difference",
    "list",
    "summarize",
    "summarise",
    "outline",
    "define",
)


def _server_default_key(provider: str) -> str:
    if provider == "openrouter":
        return settings.openrouter_api_key
    if provider == "nvidia":
        return settings.nvidia_api_key
    return ""


def _hash(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def _is_simple_query(query: str) -> bool:
    """A query short enough that query rewriting adds noise, not recall."""
    words = query.split()
    if len(words) > settings.simple_query_max_words:
        return False
    return not any(w.rstrip("?.,;:!'\"").lower() in _QUERY_MARKERS for w in words)


class QueryPipeline:
    def __init__(
        self,
        pool: asyncpg.Pool,
        redis: Redis,
        embedder: Embedder,
        chat_llm: ChatLLM,
        reranker: Reranker | OpenRouterReranker | None = None,
        router: QueryRouter | None = None,
        memory: MemoryStore | None = None,
        memory_agent: MemoryAgent | None = None,
        web: WebSearchClient | None = None,
    ) -> None:
        self.pool = pool
        self.cache = QueryCache(
            redis,
            enabled=settings.cache_enabled,
            ttl=settings.query_cache_ttl,
        )
        self.embedder = embedder
        self.chat_llm = chat_llm
        self.reranker = reranker
        self.redis = redis
        self.telemetry = Telemetry(redis)
        self.router = router
        self.memory = memory
        self.memory_agent = memory_agent
        self.web = web
        self._llm_cache: dict[tuple[str, str | None, str | None], ChatLLM] = {}
        # Fire-and-forget memory index tasks. Held here so the event loop keeps
        # a reference (CPython drops unreferenced tasks), and awaited on
        # shutdown via flush_memory_index() so exchanges survive restarts.
        self._memory_tasks: set[asyncio.Task[None]] = set()

    async def resolve_api_key(self, request: QueryRequest, provider: str | None = None) -> str | None:
        """Resolve the key for a cloud provider (user key > server default).

        The api-gateway normally resolves this already and sends it as
        ``request.api_key``; this is a fallback for direct calls.
        """
        provider = (provider or request.provider or settings.llm_provider).lower().strip()
        if provider not in CLOUD_PROVIDERS:
            return None
        if request.api_key:
            return request.api_key
        return await resolve_user_api_key(
            self.redis,
            request.user_id,
            provider,
            server_default=_server_default_key(provider),
        )

    async def _layer_key(self, user_id: str | None, provider: str) -> str | None:
        """Resolve the key for an embedding/rerank layer (user key > server default)."""
        provider = (provider or "").lower().strip()
        if provider not in CLOUD_PROVIDERS:
            return None
        return await resolve_user_api_key(
            self.redis,
            user_id,
            provider,
            server_default=_server_default_key(provider),
        )

    def resolve_chat_llm(self, provider: str | None, model: str | None, api_key: str | None) -> ChatLLM:
        """Pick the chat LLM for a request, reusing the default client when possible."""
        provider = (provider or settings.llm_provider).lower().strip()
        default = self.chat_llm
        model_ok = (model or None) in (
            None,
            getattr(default, "model", None),
            getattr(default, "chat_model", None),
        )
        key_ok = api_key is None or api_key == getattr(default, "api_key", None)
        if provider == default.provider_id and model_ok and key_ok:
            return default
        cache_key = (provider, model, api_key)
        if cache_key not in self._llm_cache:
            self._llm_cache[cache_key] = build_chat_llm(
                provider,
                ollama_base_url=settings.ollama_base_url,
                ollama_chat_model=settings.ollama_chat_model,
                ollama_embed_model=settings.ollama_embed_model,
                ollama_embed_dims=settings.ollama_embed_dims,
                gemini_api_key=settings.gemini_api_key,
                gemini_model=settings.gemini_model,
                openrouter_api_key=settings.openrouter_api_key,
                openrouter_model=settings.openrouter_chat_model,
                nvidia_api_key=settings.nvidia_api_key,
                nvidia_model=settings.nvidia_chat_model,
                model=model,
                api_key=api_key,
            )
            logger.info("chat llm switched to provider=%s model=%s", provider, model)
        return self._llm_cache[cache_key]

    # ── Query understanding ─────────────────────────────────────────────────

    async def _multi_queries(
        self,
        llm: ChatLLM,
        query: str,
        api_key: str | None,
        enabled: bool,
    ) -> list[str]:
        if not enabled:
            return [query]
        try:
            raw = await llm.complete(
                multi_query_prompt(query),
                temperature=0.3,
                max_tokens=200,
                api_key=api_key,
            )
            variants = [
                v
                for line in raw.splitlines()
                if line.strip()
                for v in [line.strip().lstrip("123.) ").strip()]
                if v
            ][:3]
            return list(dict.fromkeys([query, *variants]))[:4]
        except Exception as exc:  # noqa: BLE001
            logger.warning("multi-query generation failed: %s", exc)
            return [query]

    async def _hyde_query(
        self,
        llm: ChatLLM,
        query: str,
        api_key: str | None,
        enabled: bool,
    ) -> str | None:
        if not enabled:
            return None
        try:
            return await llm.complete(
                hyde_prompt(query),
                temperature=0.4,
                max_tokens=400,
                api_key=api_key,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("HyDE generation failed: %s", exc)
            return None

    async def _expand_parents(self, top: list[RetrievedChunk]) -> list[RetrievedChunk]:
        parent_ids = [uuid.UUID(c.parent_chunk_id) for c in top if c.parent_chunk_id]
        if not parent_ids:
            return top
        rows = await self.pool.fetch(PARENT_QUERY, parent_ids)
        by_id = {str(row["id"]): row["content"] for row in rows} if rows else {}
        for chunk in top:
            if chunk.parent_chunk_id and chunk.parent_chunk_id in by_id:
                chunk.parent_content = by_id[chunk.parent_chunk_id]
        return top

    # ── Caches ──────────────────────────────────────────────────────────────

    async def _embed_cached(
        self,
        texts: list[str],
        *,
        api_key: str | None,
        input_type: str | None,
    ) -> list[list[float]]:
        """Embed with a per-text Redis cache (query embeddings are stable)."""
        if not settings.cache_enabled or settings.embedding_cache_ttl <= 0:
            return await self.embedder.embed(texts, api_key=api_key, input_type=input_type)
        embed_model = getattr(self.embedder, "model", "") or ""
        miss: list[str] = []
        cached: dict[str, list[float]] = {}
        for text in texts:
            key = f"{EMBED_CACHE_PREFIX}:{_hash(self.embedder.provider_id, embed_model, input_type or '', text)}"
            hit = await self.redis.get(key)
            if hit is not None:
                cached[text] = json.loads(hit)
            else:
                miss.append(text)
        if miss:
            vectors = await self.embedder.embed(miss, api_key=api_key, input_type=input_type)
            for text, vector in zip(miss, vectors, strict=False):
                if vector:
                    cached[text] = vector
                    key = f"{EMBED_CACHE_PREFIX}:{_hash(self.embedder.provider_id, embed_model, input_type or '', text)}"
                    await self.redis.set(key, json.dumps(vector), ex=settings.embedding_cache_ttl)
        return [cached[t] for t in texts if t in cached]

    async def _get_cached_retrieval(
        self,
        user_id: str | None,
        query: str,
        mode: str,
        params: dict[str, Any],
        document_ids: list[str] | None = None,
    ) -> list[RetrievedChunk] | None:
        if not settings.cache_enabled or settings.retrieval_cache_ttl <= 0:
            return None
        scope = ",".join(sorted(document_ids or []))
        key = f"{RETRIEVAL_CACHE_PREFIX}:{_hash(user_id or '', query, mode, str(params['top_k']), str(params['rerank_top_n']), scope)}"
        raw = await self.redis.get(key)
        if raw is None:
            return None
        try:
            return [RetrievedChunk.model_validate(item) for item in json.loads(raw)]
        except Exception as exc:  # noqa: BLE001
            logger.warning("retrieval cache parse failed: %s", exc)
            return None

    async def _set_cached_retrieval(
        self,
        user_id: str | None,
        query: str,
        mode: str,
        params: dict[str, Any],
        chunks: list[RetrievedChunk],
        document_ids: list[str] | None = None,
    ) -> None:
        if not settings.cache_enabled or settings.retrieval_cache_ttl <= 0 or not chunks:
            return
        scope = ",".join(sorted(document_ids or []))
        key = f"{RETRIEVAL_CACHE_PREFIX}:{_hash(user_id or '', query, mode, str(params['top_k']), str(params['rerank_top_n']), scope)}"
        payload = json.dumps([c.model_dump() for c in chunks])
        await self.redis.set(key, payload, ex=settings.retrieval_cache_ttl)

    # ── Retrieval ───────────────────────────────────────────────────────────

    async def _retrieve(
        self,
        llm: ChatLLM,
        query: str,
        chat_key: str | None,
        embed_key: str | None,
        rerank_key: str | None,
        user_id: str | None,
        mode: str,
        params: dict[str, Any],
        t: dict[str, float],
        document_ids: list[str] | None = None,
    ) -> tuple[list[RetrievedChunk], bool]:
        """Run hybrid retrieval; returns ``(chunks, retrieval_cache_hit)``."""
        cached = await self._get_cached_retrieval(user_id, query, mode, params, document_ids)
        if cached is not None:
            logger.debug("retrieval cache hit for query=%r mode=%s", query, mode)
            return await self._expand_parents(cached), True

        rewrite = params["multi_query"] and not _is_simple_query(query)

        # Multi-query + HyDE are independent LLM calls — run them concurrently.
        t_mq = time.perf_counter()
        mq_task = asyncio.create_task(
            self._multi_queries(llm, query, chat_key, enabled=rewrite)
        )
        hyde_task = asyncio.create_task(
            self._hyde_query(llm, query, chat_key, enabled=params["hyde"])
        )
        queries = await mq_task
        hyde = await hyde_task
        t["query_rewrite_ms"] = round((time.perf_counter() - t_mq) * 1000, 1)
        if hyde:
            queries.append(hyde)

        queries = [q for q in queries if q and q.strip()]
        if not queries:
            queries = [query]

        embed_input_type = (
            settings.nvidia_embed_input_type
            if self.embedder.provider_id == "nvidia"
            else settings.openrouter_embed_input_type
        )
        t_emb = time.perf_counter()
        vectors = await self._embed_cached(queries, api_key=embed_key, input_type=embed_input_type)
        t["embedding_ms"] = round((time.perf_counter() - t_emb) * 1000, 1)

        # Dense search for every query vector + sparse search run concurrently.
        t_retr = time.perf_counter()
        dense_tasks = [
            dense_search(self.pool, vec, params["top_k"], user_id, document_ids)
            for vec in vectors
        ]
        dense = [item for sub in await asyncio.gather(*dense_tasks) for item in sub]

        sparse = await sparse_search(self.pool, query, params["top_k"], user_id, document_ids)
        t["retrieval_ms"] = round((time.perf_counter() - t_retr) * 1000, 1)

        merged = rrf_merge(
            dense,
            sparse,
            k=settings.rrf_k,
            top_n=max(params["rerank_top_n"], params["top_k"]),
        )

        if params["rerank"] and self.reranker is not None and merged:
            t_rr = time.perf_counter()
            merged = await self.reranker.rerank(
                query,
                merged,
                params["rerank_top_n"],
                api_key=rerank_key,
            )
            t["reranker_ms"] = round((time.perf_counter() - t_rr) * 1000, 1)
        else:
            t["reranker_ms"] = 0.0

        await self._set_cached_retrieval(user_id, query, mode, params, merged, document_ids)
        return await self._expand_parents(merged), False

    # ── Super-memory retrieval ──────────────────────────────────────────────

    async def _memory_retrieve(
        self,
        query_vector: list[float],
        user_id: str,
        query: str,
        plan: MemoryPlan,
    ) -> tuple[list[MemoryHit], list[MemoryFact], list[str]]:
        if self.memory is None:
            return [], [], []
        types = set(plan.types)
        top_k = settings.memory_top_k
        # Pull a wider semantic candidate pool so the ranker can pick the best.
        candidate_k = top_k * 3
        tasks = [
            self.memory.search_conversation(query_vector, user_id, plan.episodic_top_k * 3),
            self.memory.search_facts(query_vector, user_id, candidate_k),
        ]
        if MemoryType.RELATIONSHIP in types:
            tasks.append(self.memory.search_relationships(query_vector, user_id, top_k))
        if plan.include_critical:
            tasks.append(
                self.memory.search_critical_facts(
                    user_id,
                    plan.critical_importance,
                    plan.critical_top_k,
                )
            )
        results = await asyncio.gather(*tasks)
        hits = cast(list[MemoryHit], results[0])
        facts = cast(list[MemoryFact], results[1])
        rel_facts: list[MemoryFact] = []
        critical: list[MemoryFact] = []
        idx = 2
        if MemoryType.RELATIONSHIP in types:
            rel_facts = cast(list[MemoryFact], results[idx])
            idx += 1
        if plan.include_critical:
            critical = cast(list[MemoryFact], results[idx])
        min_score = settings.memory_min_score
        hits = [h for h in hits if h.score >= min_score][:plan.episodic_top_k]
        facts = [f for f in facts if f.score >= min_score]
        if settings.memory_rank_enabled:
            facts = rank_memory(facts, query)[:plan.semantic_top_k]
        else:
            facts = facts[:plan.semantic_top_k]
        # Critical-facts floor: high-importance durable facts (manager, contacts,
        # company, family) are always surfaced when memory is consulted, even if
        # the query's semantic match to them was weak or below min_score. The
        # same fact can come back from both paths — dedupe by id.
        if critical:
            critical_ids = {f.id for f in critical}
            facts = [
                *critical,
                *(f for f in facts if f.id not in critical_ids),
            ]
        # Frequency signal: bump access stats for what we actually recalled.
        if hits or facts or rel_facts:
            try:
                await self.memory.touch(
                    [uuid.UUID(h.id) for h in hits],
                    [uuid.UUID(f.id) for f in facts + rel_facts],
                )
            except Exception as exc:  # noqa: BLE001 - best-effort access stats
                logger.debug("memory access stats update failed: %s", exc)
        # Relationship graph walk: from the seeds we already recalled, surface
        # connected memories the query never mentioned.
        relationships: list[str] = []
        if rel_facts and self.memory_agent is not None:
            relationships = await self.memory_agent.graph_context(
                user_id,
                [f.id for f in rel_facts],
                depth=plan.graph_depth,
                top_k=plan.graph_context_top_k,
            )
        return hits, facts, relationships

    def _schedule_memory_index(
        self,
        llm: ChatLLM,
        request: QueryRequest,
        query: str,
        answer: str,
        embed_key: str | None,
        chat_key: str | None,
    ) -> None:
        """Fire-and-forget: persist this exchange into super memory after the
        answer streams. Never blocks or breaks the response."""
        if self.memory is None or not settings.memory_enabled or not request.user_id or not answer.strip():
            return
        user_id = request.user_id
        conversation_id = request.conversation_id
        history = list(request.history)
        indexer = self.memory_agent or self.memory

        async def _index() -> None:
            try:
                await indexer.index_exchange(
                    llm=llm,
                    user_id=user_id,
                    conversation_id=conversation_id,
                    query=query,
                    answer=answer,
                    history=history,
                    embed_key=embed_key,
                    chat_key=chat_key,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("memory index task failed: %s", exc)

        try:
            task = asyncio.create_task(_index())
        except RuntimeError as exc:
            logger.debug("cannot schedule memory index (loop closing?): %s", exc)
            return
        self._memory_tasks.add(task)
        task.add_done_callback(self._memory_tasks.discard)

    async def flush_memory_index(self, timeout: float = 15.0) -> None:
        """Await any in-flight memory index writes (called on shutdown).

        Without this the fire-and-forget tasks are cancelled when the event
        loop closes, silently dropping the last exchange. Best-effort: tasks
        still running after `timeout` are cancelled and logged.
        """
        if not self._memory_tasks:
            return
        done, pending = await asyncio.wait(self._memory_tasks, timeout=timeout)
        for task in pending:
            logger.warning(
                "cancelling memory index task after %ss timeout: %s",
                timeout,
                task.get_name(),
            )
            task.cancel()
        for task in done:
            exc = task.exception()
            if exc is not None:
                logger.warning("memory index task raised during flush: %s", exc)

    # ── Retrieval-only (Playground) ─────────────────────────────────────────

    async def retrieve_only(self, request: RetrieveRequest) -> dict:
        """Run the retrieval pipeline only (no conversation, no generation)."""
        t0 = time.perf_counter()
        query = request.message.strip()
        mode = (request.mode or settings.rag_mode).lower().strip()
        params = settings.rag_mode_params(mode)
        record: dict[str, Any] = {"type": "retrieve", "mode": mode, "query": query[:300]}
        try:
            api_key = await self.resolve_api_key(request)
            try:
                llm = self.resolve_chat_llm(request.provider, request.model, api_key)
            except ValueError as exc:
                logger.warning("chat llm unavailable for playground: %s", exc)
                llm = None
            record["provider"] = request.provider or "retrieve"
            record["model"] = request.model or ""

            t: dict[str, float] = {}
            chunks, cache_hit = await self._retrieve(
                llm or self.chat_llm,
                query,
                chat_key=api_key,
                embed_key=await self._layer_key(request.user_id, self.embedder.provider_id),
                rerank_key=await self._layer_key(
                    request.user_id,
                    getattr(self.reranker, "provider_id", ""),
                ),
                user_id=request.user_id,
                mode=mode,
                params=params,
                t=t,
                document_ids=request.document_ids or None,
            )

            max_score = max((c.rrf_score for c in chunks), default=0.0)
            chunks_dto = [
                {
                    "id": c.id,
                    "documentId": c.document_id,
                    "documentName": c.document_name,
                    "page": c.page_number,
                    "section": c.section,
                    "content": (c.parent_content or c.content)[:600],
                    "score": round(c.rrf_score / max_score, 4) if max_score > 0 else 0.0,
                    "denseScore": round(c.dense_score, 4) if c.dense_score else None,
                    "sparseScore": round(c.sparse_score, 4) if c.sparse_score else None,
                    "rank": c.rank,
                }
                for c in chunks
            ]
            timings = _timings(t0, t)
            record["cache_hit"] = bool(cache_hit)
            record["timings"] = timings
            record["chunk_count"] = len(chunks)
            return {
                "query": query,
                "mode": mode,
                "retrievalCacheHit": bool(cache_hit),
                "timings": timings,
                "chunks": chunks_dto,
            }
        except Exception as exc:
            logger.exception("retrieve-only failed")
            record["error"] = True
            record["error_message"] = str(exc)[:300]
            raise
        finally:
            record["total_ms"] = round((time.perf_counter() - t0) * 1000, 1)
            await self.telemetry.record(record)

    # ── Streaming ───────────────────────────────────────────────────────────

    async def stream_query(self, request: QueryRequest) -> AsyncIterator[dict[str, Any]]:
        t0 = time.perf_counter()
        query = request.message.strip()
        mode = (request.mode or settings.rag_mode).lower().strip()
        record: dict[str, Any] = {
            "type": "chat",
            "mode": mode,
            "query": query[:300],
            "user_id": request.user_id,
        }
        try:
            async for event in self._stream_query_inner(request, query, mode, t0, record):
                yield event
        finally:
            record["total_ms"] = round((time.perf_counter() - t0) * 1000, 1)
            record.setdefault("error", False)
            await self.telemetry.record(record)

    async def _stream_query_inner(
        self,
        request: QueryRequest,
        query: str,
        mode: str,
        t0: float,
        record: dict[str, Any],
    ) -> AsyncIterator[dict[str, Any]]:
        params = settings.rag_mode_params(mode)
        yield {"type": "meta", "conversationId": request.conversation_id}
        yield {"type": "status", "stage": "routing", "label": "Understanding your question…"}

        model_key = f"{request.provider or settings.llm_provider}:{request.model or 'default'}"
        cached = await self.cache.get(request.user_id, query, model_key)
        if cached:
            record["cache_hit"] = True
            record["cache"] = "query"
            for piece in _chunk_text(cached):
                yield {"type": "chunk", "text": piece}
            yield {
                "type": "done",
                "citations": [],
                "confidence": 0.0,
                "cached": True,
                "timings": _timings(t0, {}),
            }
            return

        api_key = await self.resolve_api_key(request)
        try:
            llm = self.resolve_chat_llm(request.provider, request.model, api_key)
        except ValueError as exc:
            logger.warning("chat llm unavailable: %s", exc)
            record["error"] = True
            record["error_message"] = "no provider key"
            yield {
                "type": "error",
                "message": (
                    "No API key available for this provider. Save your OpenRouter "
                    "or NVIDIA key in Settings, or ask an administrator to configure "
                    "OPENROUTER_API_KEY / NVIDIA_API_KEY."
                ),
            }
            return
        record["provider"] = llm.provider_id
        record["model"] = request.model or getattr(llm, "model", None) or ""
        yield {"type": "meta", "conversationId": request.conversation_id, "provider": llm.provider_id}

        t: dict[str, float] = {}

        # ── Query routing: let the LLM decide what this message needs ──────
        route: RoutePlan = _fallback_plan(query, request.history)
        if self.router is not None:
            route = await self.router.route(llm, query, request.history, request.user_id)
        # Explicit document scope (user pinned docs in the UI) always means RAG.
        if request.document_ids:
            route.needs_knowledge = True
            route.needs_memory = False
            route.needs_web = False
        record["intent"] = route.intent
        record["needs_knowledge"] = route.needs_knowledge
        record["needs_memory"] = route.needs_memory
        record["needs_web"] = route.needs_web

        # ── Direct-response fast path (spec: Simple Query → LLM #1) ─────────
        # A pure general message needs no document, memory or web retrieval —
        # answer from working memory only: zero retrieval, tiny prompt, fast.
        direct_path = (
            settings.memory_direct_path_enabled
            and not request.document_ids
            and not route.needs_knowledge
            and not route.needs_memory
            and not route.needs_web
        )
        record["path"] = "direct" if direct_path else "rag"
        if direct_path:
            yield {"type": "status", "stage": "direct", "label": "Answering directly…"}

        embed_key = await self._layer_key(request.user_id, self.embedder.provider_id)
        rerank_key = await self._layer_key(
            request.user_id,
            getattr(self.reranker, "provider_id", ""),
        )

        # ── Knowledge-base retrieval (only when routed to RAG) ─────────────
        top: list[RetrievedChunk] = []
        retrieval_cache_hit = False
        if route.needs_knowledge:
            yield {"type": "status", "stage": "retrieval", "label": "Searching your documents…"}
            try:
                top, retrieval_cache_hit = await self._retrieve(
                    llm,
                    query,
                    chat_key=api_key,
                    embed_key=embed_key,
                    rerank_key=rerank_key,
                    user_id=request.user_id,
                    mode=mode,
                    params=params,
                    t=t,
                    document_ids=request.document_ids or None,
                )
            except Exception as exc:
                logger.exception("retrieval failed")
                record["error"] = True
                record["error_message"] = str(exc)[:300]
                yield {"type": "error", "message": f"Retrieval failed: {exc}"}
                return
        record["cache_hit"] = bool(retrieval_cache_hit)
        record["cache"] = "retrieval" if retrieval_cache_hit else None

        # ── Super-memory retrieval (past chats + user profile) ─────────────
        # Runs on EVERY turn, not just when the router asks for memory: it's
        # one cheap embed + pgvector query, and the score threshold filters
        # noise. This lets the assistant connect "who is X?" / "did we discuss
        # Y?" to facts from earlier conversations even when the router
        # classified the message as general, web or knowledge.
        memory_hits: list[MemoryHit] = []
        memory_facts: list[MemoryFact] = []
        relationships: list[str] = []
        if not direct_path and self.memory is not None and request.user_id:
            yield {"type": "status", "stage": "memory", "label": "Recalling earlier conversations…"}
            try:
                t_mem = time.perf_counter()
                embed_input_type = (
                    settings.nvidia_embed_input_type
                    if self.embedder.provider_id == "nvidia"
                    else settings.openrouter_embed_input_type
                )
                query_vec = (
                    await self._embed_cached([query], api_key=embed_key, input_type=embed_input_type)
                )[0]
                plan = RetrievalPlanner.create_plan(
                    intent=route.intent,
                    needs_memory=route.needs_memory,
                    query=query,
                )
                memory_hits, memory_facts, relationships = await self._memory_retrieve(
                    query_vec, request.user_id, query, plan
                )
                t["memory_ms"] = round((time.perf_counter() - t_mem) * 1000, 1)
            except Exception as exc:  # noqa: BLE001 - memory is best-effort
                logger.warning("memory retrieval failed: %s", exc)
        record["memory_hits"] = len(memory_hits)
        record["memory_facts"] = len(memory_facts)

        # ── Live web context (optional, off by default) ────────────────────
        # Gated three ways: the router asked for web, the server has the feature
        # enabled (WEB_SEARCH_ENABLED), and the user opted in from the UI
        # (per-user Redis flag set by the api-gateway). When
        # web_search_require_optin is false the per-user toggle is skipped, so
        # the server-enabled feature applies to every authenticated user.
        live: list[str] = []
        web_sources: list[dict[str, Any]] = []
        web_active = (
            route.needs_web
            and settings.web_search_enabled
            and self.web is not None
            and await web_search_enabled_for(
                self.redis,
                request.user_id,
                require_optin=settings.web_search_require_optin,
            )
        )
        record["web_active"] = web_active
        if web_active:
            yield {"type": "status", "stage": "web", "label": "Checking the web…"}
            t_web = time.perf_counter()
            try:
                hits = await self.web.search_results(
                    query,
                    settings.web_search_top_k,
                    user_id=request.user_id,
                )
                web_sources = [
                    {
                        "title": r.title,
                        "url": r.url,
                        "content": r.content,
                        "provider": r.provider,
                        "score": r.score,
                    }
                    for r in hits
                ]
                live = [format_web_result(r) for r in hits]
                if web_sources:
                    yield {"type": "web_sources", "sources": web_sources}
            except Exception as exc:  # noqa: BLE001
                logger.debug("web context failed: %s", exc)
            t["web_ms"] = round((time.perf_counter() - t_web) * 1000, 1)
            record["web_sources"] = len(web_sources)

        context = _build_context(top, params["context_budget"])
        citations = build_citations(top)
        yield {"type": "sources", "citations": citations}

        if direct_path:
            messages = [{"role": "system", "content": build_direct_prompt(request.history)}]
            messages.extend(request.history)
            messages.append({"role": "user", "content": query})
            max_tokens = min(settings.llm_max_tokens, 400)
        else:
            procedural = [f.content for f in memory_facts if f.type == "procedure"]
            user_facts = [f.content for f in memory_facts if f.type != "procedure"]
            fact_budget = settings.memory_top_k + settings.memory_critical_top_k
            messages = [
                {
                    "role": "system",
                    "content": build_system_prompt(
                        context,
                        conversation_memory=[h.content for h in memory_hits[: settings.memory_top_k]],
                        user_memory=user_facts[:fact_budget],
                        procedural_memory=procedural[:fact_budget],
                        live_context=live,
                        intent=route.intent,
                        relationships=relationships,
                    ),
                }
            ]
            messages.extend(request.history)
            messages.append({"role": "user", "content": query})

            max_tokens = settings.llm_max_tokens
            if mode == "fast":
                max_tokens = min(max_tokens, 600)

        answer_parts: list[str] = []
        t_gen = time.perf_counter()
        first_token = True
        yield {"type": "status", "stage": "generation", "label": "Writing your answer…"}
        try:
            async for delta in llm.chat_stream(
                messages,
                temperature=settings.llm_temperature,
                max_tokens=max_tokens,
                api_key=api_key,
            ):
                if first_token:
                    t["llm_ttft_ms"] = round((time.perf_counter() - t_gen) * 1000, 1)
                    first_token = False
                answer_parts.append(delta)
                yield {"type": "chunk", "text": delta}
        except Exception as exc:
            logger.exception("generation failed")
            record["error"] = True
            record["error_message"] = str(exc)[:300]
            yield {"type": "error", "message": f"Generation failed: {exc}"}
            return
        t["llm_generation_ms"] = round((time.perf_counter() - t_gen) * 1000, 1)

        answer = "".join(answer_parts)
        confidence = compute_confidence(top)
        await self.cache.set(request.user_id, query, answer, model_key)

        # Persist this exchange into super memory in the background.
        self._schedule_memory_index(llm, request, query, answer, embed_key, api_key)

        if not direct_path and settings.hallucination_check_enabled and context:
            try:
                verdict = await llm.complete(
                    groundedness_prompt(query, answer, context),
                    temperature=0.0,
                    max_tokens=10,
                    api_key=api_key,
                )
                if "UNSUPPORTED" in verdict.upper():
                    yield {"type": "notice", "message": "answer may not be fully grounded"}
            except Exception as exc:  # noqa: BLE001
                logger.warning("groundedness check failed: %s", exc)

        timings = _timings(t0, t)
        record["timings"] = timings
        yield {"type": "timings", "timings": timings}
        yield {
            "type": "done",
            "citations": [c.model_dump() for c in citations],
            "confidence": confidence,
            "cached": False,
            "timings": timings,
        }


def _timings(t0: float, stage: dict[str, float]) -> dict[str, float]:
    timings = {
        "embedding_ms": stage.get("embedding_ms", 0.0),
        "retrieval_ms": stage.get("retrieval_ms", 0.0),
        "reranker_ms": stage.get("reranker_ms", 0.0),
        "llm_ttft_ms": stage.get("llm_ttft_ms", 0.0),
        "llm_generation_ms": stage.get("llm_generation_ms", 0.0),
        "total_ms": round((time.perf_counter() - t0) * 1000, 1),
    }
    if stage.get("query_rewrite_ms"):
        timings["query_rewrite_ms"] = stage["query_rewrite_ms"]
    if stage.get("memory_ms"):
        timings["memory_ms"] = stage["memory_ms"]
    if stage.get("web_ms"):
        timings["web_ms"] = stage["web_ms"]
    return timings


def _build_context(top: list[RetrievedChunk], token_budget: int) -> list[RetrievedChunk]:
    ordered = sorted(
        top,
        key=lambda c: (c.document_name or "", c.page_number or 0),
    )
    context: list[RetrievedChunk] = []
    budget = token_budget
    for chunk in ordered:
        text = chunk.parent_content or chunk.content
        cost = max(1, round(len(text) / 4))
        if budget - cost < 0:
            continue
        context.append(chunk)
        budget -= cost
    return context


def _chunk_text(text: str, size: int = 64) -> list[str]:
    return [text[i : i + size] for i in range(0, len(text), size)]
