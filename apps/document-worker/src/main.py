"""document-worker entrypoint: NATS JetStream consumer for PDF ingestion jobs."""
from __future__ import annotations

import asyncio
import json
import logging
import tempfile
import traceback
import uuid
from pathlib import Path

import nats
from nats.aio.msg import Msg
from nats.js.api import ConsumerConfig, StorageType, StreamConfig, StreamInfo
from nats.js.client import JetStreamContext
from nats.js.errors import NotFoundError
from redis.asyncio import Redis

from src.chunking import build_chunk_hierarchy
from src.config import settings
from src.domain import IngestJob
from src.embeddings import NvidiaEmbeddingClient, OllamaEmbeddingClient, OpenRouterEmbeddingClient
from src.keys import resolve_provider_key
from src.parsers import parse_pdf
from src.storage import MinioStorage, VectorStore

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s [worker] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)


async def ensure_stream(js: JetStreamContext) -> StreamInfo:
    try:
        info = await js.stream_info(settings.document_stream)
        return info
    except NotFoundError:
        return await js.add_stream(
            StreamConfig(
                name=settings.document_stream,
                subjects=["documents.>"],
                storage=StorageType.FILE,
                max_age=7 * 24 * 3600,
            )
        )


async def _set_status(
    store: VectorStore, document_id: uuid.UUID, status: str, error: str | None = None, chunk_count: int | None = None
) -> None:
    try:
        await store.set_document_status(document_id, status, error, chunk_count)
    except Exception as exc:  # noqa: BLE001 - status updates must not break the job
        logger.warning("status update to %s failed for %s: %s", status, document_id, exc)


def build_embedder(api_key: str):
    """Pick the embedding client for the configured EMBED_PROVIDER."""
    if settings.embed_provider == "openrouter":
        return OpenRouterEmbeddingClient(
            api_key=api_key,
            model=settings.openrouter_embed_model,
            dims=settings.openrouter_embed_dims,
            batch_size=settings.embed_batch_size,
        )
    if settings.embed_provider == "nvidia":
        return NvidiaEmbeddingClient(
            api_key=api_key,
            model=settings.nvidia_embed_model,
            dims=settings.nvidia_embed_dims,
            batch_size=settings.embed_batch_size,
        )
    return OllamaEmbeddingClient(
        base_url=settings.ollama_base_url,
        model=settings.ollama_embed_model,
        dims=settings.ollama_embed_dims,
        batch_size=settings.embed_batch_size,
    )


async def process_job(js: JetStreamContext, msg: Msg, job: IngestJob, redis: Redis) -> None:
    store = VectorStore()
    storage = MinioStorage()
    embed_provider = settings.embed_provider
    server_default = (
        settings.openrouter_api_key
        if embed_provider == "openrouter"
        else settings.nvidia_api_key
        if embed_provider == "nvidia"
        else ""
    )
    api_key = await resolve_provider_key(
        redis,
        job.user_id,
        embed_provider,
        server_default=server_default,
    )
    embedder = build_embedder(api_key or "")
    try:
        await _set_status(store, job.document_id, "processing")

        with tempfile.TemporaryDirectory() as tmp:
            local_path = await storage.download(job.s3_key, Path(tmp) / job.filename)
            doc = await parse_pdf(local_path, job.filename, ocr_enabled=settings.ocr_enabled)
            groups = build_chunk_hierarchy(
                doc, chunk_size=settings.chunk_size, chunk_overlap=settings.chunk_overlap
            )

            child_texts = [c.content for g in groups for c in g.children]
            embeddings = await embedder.embed(child_texts)
            child_embeddings = dict(zip(child_texts, embeddings, strict=False))

            chunk_count = await store.replace_document_chunks(job.document_id, groups, child_embeddings)
            await _set_status(store, job.document_id, "ready", chunk_count=chunk_count)

        await js.publish(
            settings.ingested_subject,
            json.dumps(
                {
                    "jobId": str(job.job_id),
                    "documentId": str(job.document_id),
                    "status": "ready",
                    "chunkCount": chunk_count,
                    "pageCount": len(doc.pages),
                }
            ).encode(),
        )
        logger.info("document %s indexed with %d chunks", job.document_id, chunk_count)
    except Exception as exc:
        logger.error("job failed for document %s: %s", job.document_id, exc)
        logger.debug(traceback.format_exc())
        await _set_status(store, job.document_id, "failed", error=str(exc)[:500])
        try:
            await js.publish(
                settings.ingested_subject,
                json.dumps(
                    {
                        "jobId": str(job.job_id),
                        "documentId": str(job.document_id),
                        "status": "failed",
                        "error": str(exc)[:500],
                    }
                ).encode(),
            )
        except Exception as exc:  # noqa: BLE001 - best effort failure notification
            logger.warning("failed to publish failure status for document %s: %s", job.document_id, exc)
        metadata = getattr(msg, "metadata", None)
        if metadata is not None and metadata.num_delivered >= 4:
            await msg.term()
        else:
            await msg.nak()
        raise
    finally:
        await embedder.aclose()
        await store.close()


async def run() -> None:
    logger.info("connecting to NATS at %s", settings.nats_url)
    nc = await nats.connect(settings.nats_url, max_reconnect_attempts=-1)
    js = nc.jetstream()
    await ensure_stream(js)

    redis = Redis(
        host=settings.redis_host,
        port=settings.redis_port,
        password=settings.redis_password or None,
        decode_responses=True,
    )

    storage = MinioStorage()
    await storage.ensure_bucket()

    store = VectorStore()
    await store.init()
    await store.close()

    sub = await js.pull_subscribe(
        settings.ingest_subject,
        durable="document-worker",
        config=ConsumerConfig(
            ack_wait=180,
            max_deliver=5,
            max_ack_pending=200,
        ),
    )
    logger.info("subscribed to %s (durable=document-worker)", settings.ingest_subject)

    try:
        while True:
            try:
                batch = await sub.fetch(10, timeout=15)
            except nats.js.errors.FetchTimeoutError:
                continue
            except Exception as exc:  # noqa: BLE001
                logger.warning("fetch error: %s", exc)
                await asyncio.sleep(2)
                continue

            for msg in batch:
                try:
                    payload = json.loads(msg.data.decode())
                    job = IngestJob.from_payload(payload)
                    logger.info("received ingest job %s (document %s)", job.job_id, job.document_id)
                    await process_job(js, msg, job, redis)
                    await msg.ack()
                except Exception as exc:  # noqa: BLE001
                    logger.error("unhandled error for message: %s", exc)
    finally:
        await redis.aclose()


async def main() -> None:
    while True:
        try:
            await run()
        except Exception as exc:  # noqa: BLE001
            logger.error("worker crashed, restarting in 5s: %s", exc)
            await asyncio.sleep(5)


if __name__ == "__main__":
    asyncio.run(main())
