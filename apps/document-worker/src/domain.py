"""Document processing domain models shared across the pipeline."""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field


@dataclass
class ParsedPage:
    number: int
    text: str
    tables: list[str] = field(default_factory=list)


@dataclass
class ParsedDocument:
    pages: list[ParsedPage]
    toc: list[tuple[int, str, int]]  # (level, title, page_number)
    filename: str


@dataclass
class IngestJob:
    job_id: uuid.UUID
    document_id: uuid.UUID
    user_id: uuid.UUID
    filename: str
    s3_key: str

    @classmethod
    def from_payload(cls, payload: dict) -> IngestJob:
        return cls(
            job_id=uuid.UUID(str(payload["jobId"])),
            document_id=uuid.UUID(str(payload["documentId"])),
            user_id=uuid.UUID(str(payload["userId"])),
            filename=str(payload["filename"]),
            s3_key=str(payload["s3Key"]),
        )
