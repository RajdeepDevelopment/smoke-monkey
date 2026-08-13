<div align="center">

# 🐵 Smoke Monkey

### Chat LLM with **super memory** & **dynamic visual** widgets

A production-grade AI chat platform that remembers every conversation across
sessions, routes each question through the smartest retrieval path, and renders
**live animated diagrams** right inside the chat — all with page-level
citations.

[![GitHub](https://img.shields.io/badge/github-RajdeepDevelopment%2Fsmoke--monkey-181717?style=for-the-badge&logo=github)](https://github.com/RajdeepDevelopment/smoke-monkey)
[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-4B0082?style=for-the-badge)](LICENSE)
[![Contributors](https://img.shields.io/github/contributors/RajdeepDevelopment/smoke-monkey?style=for-the-badge)](#contributing)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge)](CONTRIBUTING.md)

---

**Tags:** `LLM` `RAG` · `Super Memory` · `Dynamic Visual` · `Chat` · `Next.js` ·
`NestJS` · `FastAPI` · `PostgreSQL` · `pgvector` · `Redis` · `NATS JetStream` ·
`MinIO` · `Ollama` · `OpenRouter` · `NVIDIA NIM` · `Hybrid Retrieval` ·
`RRF Fusion` · `HyDE` · `SSE` · `Agentic Router`

![logo](assets/logo.png)

</div>

---

## ✨ What makes Smoke Monkey special

| Capability | What it does |
|---|---|
| 🧠 **Super memory** | Every exchange is embedded into a vector store and durable user facts (preferences, projects) are extracted into a long-term profile. It **answers as if it already knows you** — never announcing that it consulted a memory store. |
| 🎨 **Dynamic visual** | The LLM can drop **animated canvas widgets** into the answer stream — flowcharts, sorting demos, algorithm walkthroughs — rendered live, sandboxed, in the chat. |
| 🗂️ **Document RAG** | Upload PDFs; ask natural-language questions; get streamed answers with `[n]` **page-level citations**. |
| 🧭 **Agentic query router** | An LLM router decides per message between **knowledge base**, **conversation memory**, **live web**, or **plain chat**. |
| 🔎 **Hybrid retrieval** | Dense (pgvector) + sparse (Postgres FTS) fused with **RRF**, refined with cross-encoder **reranking**, HyDE and multi-query expansion. |
| 🔐 **User-owned keys** | Users can plug in their own OpenRouter/NVIDIA keys — encrypted at rest (AES-256-GCM) and cached in Redis. |

## 🧩 Tech stack

| Layer | Technologies |
|---|---|
| Frontend | ![Next.js](https://img.shields.io/badge/Next.js-000000?logo=nextdotjs&logoColor=white) ![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB) ![Tailwind](https://img.shields.io/badge/Tailwind_CSS-38B2AC?logo=tailwindcss&logoColor=white) |
| Backend | ![NestJS](https://img.shields.io/badge/NestJS-E0234E?logo=nestjs&logoColor=white) ![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white) ![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white) |
| Data & AI | ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white) ![pgvector](https://img.shields.io/badge/pgvector-316192?logo=postgresql&logoColor=white) ![Redis](https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white) ![Ollama](https://img.shields.io/badge/Ollama-000000?logo=ollama&logoColor=white) |
| Messaging & Storage | ![NATS](https://img.shields.io/badge/NATS_JetStream-27AAE1?logo=nats&logoColor=white) ![MinIO](https://img.shields.io/badge/MinIO-C72E49?logo=minio&logoColor=white) |
| Infra | ![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white) ![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?logo=kubernetes&logoColor=white) ![Terraform](https://img.shields.io/badge/Terraform-844FBA?logo=terraform&logoColor=white) |

## 🏗️ Architecture at a glance

```mermaid
flowchart LR
    subgraph Client
        W["web · Next.js"]
    end
    subgraph Control_Plane
        G["api-gateway · NestJS<br/>auth · uploads · SSE proxy"]
        R["rag-service · FastAPI<br/>router · retrieval · streaming"]
    end
    subgraph Async
        N["NATS JetStream<br/>documents.ingest"]
        DW["document-worker<br/>parse → chunk → embed"]
    end
    subgraph Storage
        P[("PostgreSQL + pgvector<br/>chunks · memory · FTS")]
        M[("MinIO · S3")]
        RD[("Redis · cache")]
    end
    subgraph LLM
        O["Ollama (local)"]
        OR["OpenRouter / NVIDIA NIM"]
    end

    W -- "HTTP/SSE" --> G
    G -- "query · SSE" --> R
    G -- "publish" --> N
    N -- "consume" --> DW
    DW -- "embed" --> O
    DW --> P
    G --> M
    R --> P
    R --> RD
    R --> O
    R --> OR
```

## 🚀 Quick start

Requires Docker + Docker Compose (~8 GB free disk for local models).

```bash
cp .env.example .env        # configure providers (or use local Ollama)
make up                     # build & start the full stack
docker compose logs -f ollama   # wait for model pulls (first run)
make seed-user              # demo account: demo@rag.local
make web                    # open http://localhost:3001
```

Then: sign in → **Knowledge Base** → upload a PDF → wait for `ready` →
**Chat** → ask away. Answers stream in with sources.

### Ports

| Service | URL |
|---|---|
| Web app | http://localhost:3001 |
| API gateway | http://localhost:3000 |
| rag-service | http://localhost:8000 |
| Ollama | http://localhost:11434 |
| MinIO console | http://localhost:9001 |
| NATS monitor | http://localhost:8222 |
| Postgres | localhost:5432 |

## 📚 Documentation

- **[Architecture](docs/architecture.md)** — system overview, data flow, SSE contract
- **[Hybrid retrieval flow](docs/retrieval-flow.md)** — retrieval algorithm with mermaid + canvas specs
- **[Super memory](docs/super-memory.md)** — conversation memory & durable user-fact algorithm
- **[Dynamic visual widgets](docs/dynamic-visual.md)** — the `canvas` add-on system
- **[Contributing](CONTRIBUTING.md)** · **[Security](SECURITY.md)** · **[Code of conduct](CODE_OF_CONDUCT.md)**

## 🗂️ Project structure

```
smoke-monkey/
├── apps/
│   ├── api-gateway/        NestJS — auth, uploads, chat SSE, health
│   ├── rag-service/        FastAPI — query pipeline, retrieval, streaming
│   ├── document-worker/    async PDF ingestion (parse → chunk → embed → index)
│   └── web/                Next.js — chat + documents + canvas renderer
├── packages/               shared TS contracts / config
├── infrastructure/         docker, k8s, helm, terraform
└── docs/                   architecture + algorithm docs (mermaid)
```

## ⚙️ Key configuration

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `openrouter` | `ollama` / `openrouter` / `nvidia` / `gemini` |
| `ROUTER_ENABLED` | `true` | agentic query router |
| `MEMORY_ENABLED` | `true` | conversation memory embeddings + fact extraction |
| `MEMORY_TOP_K` | `5` | memory hits injected into the answer prompt |
| `WEB_SEARCH_ENABLED` | `false` | live web context (DuckDuckGo, no key) |
| `JWT_SECRET` | `change-me-in-production` | **set a real secret** |

See [`.env.example`](.env.example) for the full list. **Never commit your `.env`.**

## 🤝 Contributing

Contributions of all kinds are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the workflow, code standards, and the **secret-handling policy**. Pre-commit
hooks (gitleaks + detect-secrets) block secrets from entering git history.

## 📄 License

**Non-commercial.** This project is licensed under the
[PolyForm Noncommercial License 1.0.0](LICENSE) — you may use, modify, and
distribute it for **noncommercial purposes** (research, education, personal
projects, nonprofits). Commercial use requires a separate license from the
maintainer.
