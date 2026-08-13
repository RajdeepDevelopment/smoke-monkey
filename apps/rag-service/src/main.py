"""rag-service entrypoint."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

import asyncpg
from fastapi import FastAPI
from redis.asyncio import Redis

from src.api.routes import router
from src.application.mem.agent import MemoryAgent
from src.application.mem.graph import GraphMemoryStore
from src.application.memory import MemoryStore
from src.application.pipeline import QueryPipeline
from src.application.router import QueryRouter
from src.application.websearch import WebSearchClient
from src.config import settings
from src.generation import (
    OllamaClient,
    OllamaEmbedder,
    OpenRouterClient,
    OpenRouterEmbedder,
    build_chat_llm,
)
from src.retrieval import OpenRouterReranker, Reranker

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s [rag-service] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)


def _cloud_client(provider: str, *, chat_model: str, key: str) -> OpenRouterClient | None:
    """Build an OpenAI-compatible client for the openrouter/nvidia providers."""
    if provider == "openrouter":
        return OpenRouterClient(
            api_key=key,
            model=chat_model,
            embed_model=settings.openrouter_embed_model,
            embed_dims=settings.openrouter_embed_dims,
            provider_id="openrouter",
            name="OpenRouter",
            base_url=settings.openrouter_base_url,
        )
    if provider == "nvidia":
        return OpenRouterClient(
            api_key=key,
            model=chat_model,
            embed_model=settings.nvidia_embed_model,
            embed_dims=settings.nvidia_embed_dims,
            provider_id="nvidia",
            name="NVIDIA NIM",
            base_url=settings.nvidia_base_url,
            rerank_url=settings.nvidia_rerank_base_url,
            rerank_style="nvidia",
        )
    return None


def build_embedder() -> OpenRouterEmbedder | OllamaEmbedder:
    """Build the embedding adapter for the configured EMBED_PROVIDER."""
    if settings.embed_provider == "openrouter":
        client = _cloud_client(
            "openrouter",
            chat_model=settings.openrouter_chat_model,
            key=settings.openrouter_api_key or "",
        )
        assert client is not None
        return OpenRouterEmbedder(client)
    if settings.embed_provider == "nvidia":
        client = _cloud_client(
            "nvidia",
            chat_model=settings.nvidia_chat_model,
            key=settings.nvidia_api_key or "",
        )
        assert client is not None
        return OpenRouterEmbedder(client)
    ollama = OllamaClient(
        base_url=settings.ollama_base_url,
        chat_model=settings.ollama_chat_model,
        embed_model=settings.ollama_embed_model,
        embed_dims=settings.ollama_embed_dims,
    )
    return OllamaEmbedder(ollama)


def build_reranker():
    """Prefer the cloud cross-encoder (OpenRouter/NVIDIA); fall back to local."""
    if settings.openrouter_rerank_enabled:
        client = _cloud_client(
            "openrouter",
            chat_model=settings.openrouter_chat_model,
            key=settings.openrouter_api_key or "",
        )
        if client is not None:
            return OpenRouterReranker(client)
    if settings.nvidia_rerank_enabled:
        client = _cloud_client(
            "nvidia",
            chat_model=settings.nvidia_chat_model,
            key=settings.nvidia_api_key or "",
        )
        if client is not None:
            return OpenRouterReranker(client)
    if settings.rerank_enabled:
        try:
            return Reranker(settings.rerank_model)
        except Exception as exc:  # noqa: BLE001
            logger.error("local reranker disabled: %s", exc)
    return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    pool = await asyncpg.create_pool(settings.postgres_dsn, min_size=2, max_size=10)
    async with pool.acquire() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS feedback (
                id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                message_id  TEXT NOT NULL,
                helpful     BOOLEAN,
                comment     TEXT,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
    redis = Redis(
        host=settings.redis_host,
        port=settings.redis_port,
        password=settings.redis_password or None,
        decode_responses=True,
    )
    embedder = build_embedder()

    try:
        chat_llm = build_chat_llm(
            settings.llm_provider,
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
        )
    except ValueError as exc:
        logger.warning("chat llm init failed: %s; falling back to Ollama", exc)
        chat_llm = OllamaClient(
            base_url=settings.ollama_base_url,
            chat_model=settings.ollama_chat_model,
            embed_model=settings.ollama_embed_model,
            embed_dims=settings.ollama_embed_dims,
        )

    reranker = build_reranker()

    # Super memory: pgvector tables for conversation + user-profile memory.
    memory_store = MemoryStore(pool, embedder)
    await memory_store.ensure_schema()
    try:
        # Spec Consolider: purge expired facts + aged episodic memory at boot.
        await memory_store.consolidate()
    except Exception as exc:  # noqa: BLE001 - consolidation is best-effort
        logger.warning("memory consolidation failed at startup: %s", exc)
    web_search = (
        WebSearchClient(
            settings.web_search_top_k,
            redis=redis,
            providers=[p.strip() for p in settings.web_search_providers.split(",") if p.strip()],
            cache_ttl=settings.web_search_cache_ttl,
            server_keys={
                "tavily": settings.tavily_api_key,
                "google": settings.google_search_api_key,
                "brave": settings.brave_api_key,
                "bing": settings.bing_api_key,
            },
            google_cx=settings.google_search_cx,
            tavily_search_depth=settings.tavily_search_depth,
        )
        if settings.web_search_enabled
        else None
    )

    # Relationship graph memory: Neo4j-backed human-association layer. Skipped
    # entirely when disabled; a missing neo4j driver or a bad URI degrades to a
    # no-op (graph stays disabled, pgvector memory is unaffected).
    graph_store = GraphMemoryStore(
        uri=settings.neo4j_uri,
        user=settings.neo4j_user,
        password=settings.neo4j_password,
    )
    if settings.neo4j_enabled:
        await graph_store.connect()
        await graph_store.ensure_schema()
    memory_agent = MemoryAgent(store=memory_store, graph=graph_store, embedder=embedder)

    app.state.pool = pool
    app.state.redis = redis
    app.state.embedder = embedder
    app.state.llm = chat_llm
    app.state.web = web_search
    app.state.pipeline = QueryPipeline(
        pool=pool,
        redis=redis,
        embedder=embedder,
        chat_llm=chat_llm,
        reranker=reranker,
        router=QueryRouter(redis),
        memory=memory_store,
        memory_agent=memory_agent,
        web=web_search,
    )
    app.state.telemetry = app.state.pipeline.telemetry

    logger.info(
        "rag-service ready (provider=%s, embed=%s, rerank=%s, router=%s, memory=%s, graph=%s)",
        chat_llm.provider_id,
        embedder.provider_id,
        type(reranker).__name__ if reranker else "off",
        "on" if settings.router_enabled else "off",
        "on" if settings.memory_enabled else "off",
        "on" if graph_store.enabled else "off",
    )
    try:
        yield
    finally:
        # Let in-flight memory index writes finish before tearing down the
        # embedder/pool, otherwise the last exchange is lost.
        try:
            await app.state.pipeline.flush_memory_index()
        except Exception as exc:  # noqa: BLE001
            logger.warning("memory index flush failed during shutdown: %s", exc)
        closeables: list[object] = [chat_llm]
        embed_client = getattr(embedder, "_client", None)
        if embed_client is not None:
            closeables.append(embed_client)
        if reranker is not None:
            rerank_client = getattr(reranker, "_client", None)
            if rerank_client is not None:
                closeables.append(rerank_client)
        web = getattr(app.state, "web", None)
        if web is not None:
            closeables.append(web)
        for obj in closeables:
            close = getattr(obj, "aclose", None)
            if close is not None:
                try:
                    await close()
                except Exception as exc:  # noqa: BLE001
                    logger.debug("close failed for %s: %s", type(obj).__name__, exc)
        await redis.aclose()
        await pool.close()


app = FastAPI(title="rag-service", version="0.1.0", lifespan=lifespan)
app.include_router(router)
