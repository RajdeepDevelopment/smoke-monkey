"""Post-processing: citations, confidence scoring, groundedness check."""
from __future__ import annotations

from src.domain import Citation, RetrievedChunk


def compute_confidence(top: list[RetrievedChunk]) -> float:
    if not top:
        return 0.0
    weights = [max(c.rrf_score, 0.0) for c in top]
    return round(min(sum(weights) / max(len(weights), 1) * 10, 1.0), 4)


def build_citations(top: list[RetrievedChunk]) -> list[Citation]:
    citations: list[Citation] = []
    seen: set[tuple[str, int | None, str]] = set()
    for c in top:
        key = (c.document_id, c.page_number, c.content[:120])
        if key in seen:
            continue
        seen.add(key)
        citations.append(
            Citation(
                documentId=c.document_id,
                documentName=c.document_name,
                page=c.page_number,
                text=c.content[:500],
                score=round(c.rrf_score, 4),
            )
        )
    # RRF scores are tiny reciprocal-rank values; normalize so the UI can show
    # them as a readable relevance percentage (top result = 100%).
    max_score = max((cit.score for cit in citations), default=0.0)
    if max_score > 0:
        for cit in citations:
            cit.score = round(cit.score / max_score, 4)
    return citations
