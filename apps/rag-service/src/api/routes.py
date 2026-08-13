"""HTTP routes: health, streaming query (SSE), feedback."""
from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Request
from sse_starlette.sse import EventSourceResponse

from src.config import settings
from src.domain import FeedbackRequest, QueryRequest, RetrieveRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1")


def _json_default(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


async def _json_sse(event: dict) -> dict[str, str]:
    return {"event": event["type"], "data": json.dumps(event, default=_json_default)}


@router.get("/health")
async def health(request: Request) -> dict:
    state = request.app.state
    checks = {"embeddings": False, "chat": False, "postgres": False, "redis": False}
    try:
        checks["embeddings"] = await state.embedder.ping()
    except Exception:
        logger.debug("embeddings health probe failed", exc_info=True)
    try:
        checks["chat"] = await state.llm.ping()
    except Exception:
        logger.debug("chat health probe failed", exc_info=True)
    try:
        async with state.pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        checks["postgres"] = True
    except Exception:
        logger.debug("postgres health probe failed", exc_info=True)
    try:
        await state.redis.ping()
        checks["redis"] = True
    except Exception:
        logger.debug("redis health probe failed", exc_info=True)
    healthy = all(checks.values())
    return {"status": "ok" if healthy else "degraded", **checks}


@router.get("/models")
async def models() -> dict:
    """Advertise chat providers, the active embedding/rerank layers and a
    dynamic model catalog so the UI can show what's available per RAG stage.
    The catalog (providers + recommended presets) is data-driven — edit
    `src/config/model_catalog.json` to change it without touching code."""
    catalog = settings.model_catalog
    provider_labels = catalog.get("providers") or {}

    def label(provider_id: str) -> str:
        return (provider_labels.get(provider_id) or {}).get("label") or provider_id.title()

    providers: list[dict] = [
        {
            "id": "ollama",
            "label": "Local (Ollama)",
            "models": [settings.ollama_chat_model],
        }
    ]
    if settings.gemini_api_key:
        providers.append(
            {
                "id": "gemini",
                "label": "Google Gemini (cloud)",
                "models": [m.strip() for m in settings.gemini_models.split(",") if m.strip()],
            }
        )
    or_models = [m.strip() for m in settings.openrouter_chat_models.split(",") if m.strip()] or [
        settings.openrouter_chat_model
    ]
    providers.append({"id": "openrouter", "label": "OpenRouter (cloud)", "models": or_models})
    nv_models = [m.strip() for m in settings.nvidia_chat_models.split(",") if m.strip()] or [
        settings.nvidia_chat_model
    ]
    providers.append({"id": "nvidia", "label": "NVIDIA NIM (cloud)", "models": nv_models})

    if settings.embed_provider == "openrouter":
        embedding = {
            "provider": "openrouter",
            "model": settings.openrouter_embed_model,
            "dims": settings.openrouter_embed_dims,
        }
    elif settings.embed_provider == "nvidia":
        embedding = {
            "provider": "nvidia",
            "model": settings.nvidia_embed_model,
            "dims": settings.nvidia_embed_dims,
        }
    else:
        embedding = {
            "provider": "ollama",
            "model": settings.ollama_embed_model,
            "dims": settings.ollama_embed_dims,
        }

    if settings.openrouter_rerank_enabled:
        rerank = {
            "enabled": True,
            "provider": "openrouter",
            "model": settings.openrouter_rerank_model,
        }
    elif settings.nvidia_rerank_enabled:
        rerank = {
            "enabled": True,
            "provider": "nvidia",
            "model": settings.nvidia_rerank_model,
        }
    elif settings.rerank_enabled:
        rerank = {"enabled": True, "provider": "local", "model": settings.rerank_model}
    else:
        rerank = {"enabled": False, "provider": "none", "model": ""}

    def chat_model_entry(model_id: str, provider: str) -> dict:
        return {
            "id": model_id,
            "name": model_id,
            "provider": provider,
            "isFree": model_id.endswith(":free"),
        }

    chat_models = (
        [chat_model_entry(m, "openrouter") for m in or_models]
        + [chat_model_entry(m, "nvidia") for m in nv_models]
        + [chat_model_entry(settings.ollama_chat_model, "ollama")]
    )

    # Recommended presets from the dynamic catalog (the "model picker" table).
    presets: list[dict] = []
    for preset in catalog.get("presets") or []:
        entry = dict(preset)
        entry["providerLabel"] = label(entry.get("provider", ""))
        presets.append(entry)

    catalog_models = {
        "chatModels": chat_models,
        "embeddingModels": [
            {"id": "nvidia/nemotron-3-embed-1b", "name": "NVIDIA Nemotron 3 Embed 1B", "provider": "NVIDIA", "dims": 2048, "notes": "fast/cheap RAG, 32768 context"},
            {"id": "nvidia/llama-nemotron-embed-1b-v2", "name": "NVIDIA Llama Nemotron Embed 1B V2", "provider": "NVIDIA", "dims": 1024, "notes": "multilingual retrieval"},
            {"id": "nvidia/llama-nemotron-embed-vl-1b-v2", "name": "NVIDIA Nemotron Embed VL 1B V2", "provider": "NVIDIA", "notes": "multimodal documents"},
            {"id": "qwen/qwen3-embedding-8b", "name": "Qwen3 Embedding 8B", "provider": "Qwen", "dims": 4096, "notes": "best overall retrieval, multilingual, code"},
            {"id": "baai/bge-m3", "name": "BGE-M3", "provider": "BAAI", "dims": 1024, "notes": "general RAG, multilingual"},
        ],
        "rerankModels": [
            {"id": "nvidia/llama-nemotron-rerank-vl-1b-v2", "name": "NVIDIA Llama Nemotron Rerank VL 1B V2", "provider": "NVIDIA"},
            {"id": "nvidia/llama-nemotron-rerank-1b-v2", "name": "NVIDIA Llama Nemotron Rerank 1B V2", "provider": "NVIDIA"},
            {"id": "cohere/rerank-v3.5", "name": "Cohere Rerank 3.5", "provider": "Cohere"},
        ],
    }

    return {
        "providers": providers,
        "defaultProvider": settings.llm_provider,
        "embedding": embedding,
        "rerank": rerank,
        "catalog": catalog_models,
        "presets": presets,
    }


@router.post("/query")
async def query(request: Request, body: QueryRequest) -> EventSourceResponse:
    state = request.app.state

    async def generator():
        try:
            async for event in state.pipeline.stream_query(body):
                yield await _json_sse(event)
        except Exception as exc:
            logger.exception("query stream failed")
            yield await _json_sse({"type": "error", "message": str(exc)})

    return EventSourceResponse(generator(), media_type="text/event-stream")


@router.post("/retrieve")
async def retrieve(request: Request, body: RetrieveRequest) -> dict:
    """Retrieval-only endpoint for the Playground (no generation, no chat)."""
    state = request.app.state
    return await state.pipeline.retrieve_only(body)


@router.get("/metrics")
async def metrics(request: Request) -> dict:
    """Aggregated analytics summary from the Redis telemetry tail."""
    state = request.app.state
    return await state.telemetry.summary()


@router.post("/feedback")
async def feedback(request: Request, body: FeedbackRequest) -> dict:
    state = request.app.state
    async with state.pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO feedback (id, message_id, helpful, comment, created_at)
            VALUES (gen_random_uuid(), $1, $2, $3, now())
            """,
            body.message_id,
            body.helpful,
            body.comment,
        )
    return {"status": "ok"}
