import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict

MODEL_CATALOG_DEFAULT = Path(__file__).parent / "config" / "model_catalog.json"


@lru_cache
def load_model_catalog(path: str = "") -> dict[str, Any]:
    """Load the dynamic model catalog (provider labels + recommended presets).

    The catalog is plain data — edit it (or point MODEL_CATALOG_PATH at a
    different file) to change what the UI recommends without touching code.
    """
    catalog_path = Path(path or str(MODEL_CATALOG_DEFAULT))
    if not catalog_path.exists():
        return {"providers": {}, "presets": []}
    try:
        return json.loads(catalog_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"providers": {}, "presets": []}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_user: str = "rag"
    postgres_password: str = "rag_secret"
    postgres_db: str = "ragdb"

    redis_host: str = "localhost"
    redis_port: int = 6379
    redis_password: str = ""

    ollama_base_url: str = "http://localhost:11434"
    ollama_chat_model: str = "qwen3:8b"
    ollama_embed_model: str = "nomic-embed-text"
    ollama_embed_dims: int = 768

    # Chat LLM provider: "ollama" (self-hosted), "openrouter" (cloud) or
    # "gemini" (Google AI Studio free tier)
    llm_provider: str = "ollama"
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.5-flash"
    gemini_models: str = "gemini-3.5-flash,gemini-3.6-flash,gemini-3.1-flash-lite"

    # OpenRouter (cloud) — chat models (change freely; `:free` variants need no credits)
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_chat_model: str = "nvidia/nemotron-3-nano-30b-a3b:free"
    openrouter_chat_models: str = (
        "nvidia/nemotron-3-nano-30b-a3b:free,nvidia/nemotron-3-super-120b-a12b:free,"
        "deepseek/deepseek-v4-flash,deepseek/deepseek-v4-pro,z-ai/glm-5.2,"
        "nvidia/nemotron-3-ultra-550b-a55b"
    )

    # NVIDIA NIM (cloud) — OpenAI-compatible chat/embeddings at
    # integrate.api.nvidia.com and a dedicated retrieval rerank endpoint.
    nvidia_api_key: str = ""
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    nvidia_rerank_base_url: str = (
        "https://ai.api.nvidia.com/v1/retrieval/nvidia/llama-nemotron-rerank-1b-v2"
    )
    nvidia_chat_model: str = "nvidia/nemotron-3-nano-30b-a3b"
    nvidia_chat_models: str = (
        "nvidia/nemotron-3-nano-30b-a3b,nvidia/nemotron-3-super-120b-a12b,"
        "nvidia/nemotron-3-ultra-550b-a55b,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
    )

    # Embedding provider: "openrouter" (cloud, default), "nvidia" (cloud) or
    # "ollama" (local). The embedding model is server-global — the pgvector
    # column is fixed-dim, so changing model/dims requires reindexing chunks.
    embed_provider: str = "openrouter"
    openrouter_embed_model: str = "nvidia/nemotron-3-embed-1b:free"
    openrouter_embed_dims: int = 2048
    nvidia_embed_model: str = "nvidia/nemotron-3-embed-1b"
    nvidia_embed_dims: int = 2048

    # Rerank layer: cloud provider is "openrouter" or "nvidia"; local fallback
    # is the torch-based cross-encoder (needs the 'rerank' extra).
    openrouter_rerank_enabled: bool = True
    openrouter_rerank_model: str = "nvidia/llama-nemotron-rerank-vl-1b-v2:free"
    nvidia_rerank_enabled: bool = False
    nvidia_rerank_model: str = "nvidia/llama-nemotron-rerank-1b-v2"

    # Optional override for the model catalog file (see config/model_catalog.json)
    model_catalog_path: str = ""

    hyde_enabled: bool = True
    multi_query_enabled: bool = True
    rerank_enabled: bool = False
    rerank_model: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"
    cache_enabled: bool = True
    query_cache_ttl: int = 300
    embedding_cache_ttl: int = 86400
    retrieval_cache_ttl: int = 300
    hallucination_check_enabled: bool = False

    # RAG retrieval depth. Each mode is a named preset of the knobs below;
    # "fast" skips query rewriting, HyDE and the reranker for lowest latency.
    rag_mode: str = "balanced"
    top_k: int = 20
    rerank_top_n: int = 5
    context_token_budget: int = 6000
    llm_temperature: float = 0.2
    llm_max_tokens: int = 1024
    rrf_k: int = 60
    # Simple queries (≤ this many words, no question/domain markers) skip
    # multi-query + HyDE rewriting to cut embedding/LLM calls and latency.
    simple_query_max_words: int = 4

    # ── Agentic query routing ───────────────────────────────────────────────
    # Every chat message is classified by the LLM before retrieval so general
    # questions skip RAG, personal questions hit conversation memory, and only
    # document questions run vector retrieval. When disabled, the pipeline
    # behaves like a plain RAG chatbot (knowledge retrieval for everything).
    router_enabled: bool = True
    router_cache_ttl: int = 300

    # ── Super memory ────────────────────────────────────────────────────────
    # Embeds each user/assistant message into pgvector (conversation memory)
    # and extracts durable facts (preferences/projects) into a user profile.
    memory_enabled: bool = True
    memory_top_k: int = 5
    memory_min_score: float = 0.12
    memory_extract_enabled: bool = True
    memory_extract_min_importance: float = 0.5

    # Direct-response fast path (spec: LLM #1). General/simple questions skip
    # document + memory retrieval entirely and are answered from working memory
    # (the recent turns) — ~zero DB work, much lower latency and tokens.
    memory_direct_path_enabled: bool = True

    # Weighted memory ranker (spec: Memory Ranker). After the cheap semantic
    # filter, hits are re-ranked with
    #   score = semantic*w_s + recency*w_r + frequency*w_f + context*w_c
    #         + importance*w_i
    # importance is part of the blend so high-value durable facts (manager,
    # contacts, identity) are never outranked by loose-matching trivia.
    # recency decays exponentially with this half-life (hours) from the LAST
    # time the memory was used (a human-like forgetting curve: each recall
    # resets the freshness clock).
    memory_rank_enabled: bool = True
    memory_weight_semantic: float = 0.3
    memory_weight_recency: float = 0.2
    memory_weight_frequency: float = 0.15
    memory_weight_context: float = 0.1
    memory_weight_importance: float = 0.25
    memory_recency_half_life_hours: float = 72.0

    # Critical-facts floor (spec: Memory Ranker, guaranteed recall). Whenever
    # memory is consulted, the user's facts with importance >= this value are
    # always retrieved (up to `memory_critical_top_k`), even when the current
    # query only loosely matches them. This keeps identity/relationship facts
    # (manager, company, contacts, family) available across new conversations.
    memory_critical_importance: float = 0.8
    memory_critical_top_k: int = 3

    # Write pipeline (spec: Deduplicator + Resolver). Before a new fact is
    # stored its embedding is compared against the user's existing memories;
    # cosine similarity >= ignore → skip (refresh recency), >= merge → update
    # the existing record (keep highest importance), below merge → store new.
    memory_dedupe_ignore: float = 0.9
    memory_dedupe_merge: float = 0.72

    # Consolider (spec: Memory Scorer + Consolider). Facts get a TTL tier from
    # their importance; expired rows are purged by the startup consolidation.
    # Human-like forgetting is layered on top:
    #  - memory_reconsolidation_boost: each recall strengthens a fact's
    #    importance by this much (capped at 1.0) — the more a memory is used,
    #    the more durable it becomes (spaced-repetition effect).
    #  - memory_decay_grace_days / memory_decay_daily: below-critical facts
    #    start losing importance after this many days without recall, at this
    #    rate per day. Critical facts (importance >= memory_critical_importance)
    #    are protected — they are the user's identity/relationships.
    #  - memory_forget_floor: facts that decay below this are forgotten
    #    (deleted). The consolidation also merges near-duplicate facts (same
    #    concept restated) into a single canonical memory.
    memory_consolidate_enabled: bool = True
    memory_episodic_retention_days: int = 180
    memory_reconsolidation_boost: float = 0.01
    memory_decay_grace_days: float = 30.0
    memory_decay_daily: float = 0.002
    memory_forget_floor: float = 0.2

    # ── Relationship memory / Graph DB (Neo4j) ─────────────────────────────
    # The memory agent also stores memories as nodes in a Neo4j graph and links
    # them with typed edges (RELATED_TO, WORKS_WITH, PREFERS, ...). Retrieval
    # can then walk the graph around the semantic hits to surface *connected*
    # memories the query never literally mentions (human association memory).
    # When neo4j_enabled is off the graph layer is skipped entirely — the
    # pgvector memory still works exactly as before.
    neo4j_enabled: bool = False
    neo4j_uri: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "neo4j_password"
    # Entity → memory matching: an extracted relationship (subject/object) is
    # linked to an existing memory whose embedding is at least this similar.
    memory_graph_enabled: bool = True
    memory_graph_match_threshold: float = 0.66
    memory_graph_context_depth: int = 1
    memory_graph_context_top_k: int = 6
    memory_relationship_embed_threshold: float = 0.66

    # ── Live web context (optional) ─────────────────────────────────────────
    # Multi-provider live search: queries all providers that have a key (user's
    # own saved key wins over the server defaults below) and merges the hits.
    # Free DuckDuckGo (no key) acts as the fallback. Results are cached for
    # `web_search_cache_ttl` seconds so repeat queries don't burn provider quota
    # (Tavily's free tier is ~1k searches/month — keep search depth "basic").
    web_search_enabled: bool = False
    web_search_top_k: int = 5
    web_search_cache_ttl: int = 21600
    web_search_providers: str = "tavily,google,brave,bing,duckduckgo"
    # When true (default) web search additionally requires the per-user opt-in
    # flag set from Settings → Web search. Set false so the server-enabled
    # feature applies to every authenticated user.
    web_search_require_optin: bool = True
    # Server defaults for the keyed providers (user keys always win).
    tavily_api_key: str = ""
    tavily_search_depth: str = "basic"
    google_search_api_key: str = ""
    google_search_cx: str = ""
    brave_api_key: str = ""
    bing_api_key: str = ""

    @property
    def openrouter_embed_input_type(self) -> str | None:
        """Some NVIDIA embedding models need a query/passage hint per call."""
        model = self.openrouter_embed_model.lower()
        return "query" if "nemotron" in model else None

    @property
    def nvidia_embed_input_type(self) -> str | None:
        model = self.nvidia_embed_model.lower()
        return "query" if "nemotron" in model else None

    @property
    def model_catalog(self) -> dict[str, Any]:
        return load_model_catalog(self.model_catalog_path)

    def rag_mode_params(self, mode: str) -> dict[str, Any]:
        """Resolve per-mode retrieval tuning for `fast | balanced | deep`.

        Latency/quality trade-off ladder:
        - fast:     1 embedding call, no rewriting, no rerank, small topK.
        - balanced: no HyDE (keeps one extra LLM call out of the hot path),
                    rerank on, medium topK. This is the default.
        - deep:     multi-query + HyDE + rerank, largest topK.
        """
        mode = (mode or self.rag_mode).lower().strip()
        table = {
            "fast": {
                "multi_query": False,
                "hyde": False,
                "rerank": False,
                "top_k": 8,
                "rerank_top_n": 0,
                "context_budget": 4000,
            },
            "balanced": {
                "multi_query": self.multi_query_enabled,
                "hyde": False,
                "rerank": self.openrouter_rerank_enabled or self.nvidia_rerank_enabled or self.rerank_enabled,
                "top_k": self.top_k,
                "rerank_top_n": self.rerank_top_n,
                "context_budget": self.context_token_budget,
            },
            "deep": {
                "multi_query": True,
                "hyde": True,
                "rerank": self.openrouter_rerank_enabled or self.nvidia_rerank_enabled or self.rerank_enabled,
                "top_k": max(self.top_k, 20),
                "rerank_top_n": max(self.rerank_top_n, 5),
                "context_budget": self.context_token_budget,
            },
        }
        return table.get(mode, table["balanced"])

    @property
    def postgres_dsn(self) -> str:
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
