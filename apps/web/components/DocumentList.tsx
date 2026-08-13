'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DocumentDto, DocumentStatus } from '@rag/contracts';
import { api } from '../lib/api';

const STATUS_STYLE: Record<DocumentStatus, string> = {
  uploading: 'bg-amber-500/15 text-amber-300 border-amber-700/50',
  processing: 'bg-sky-500/15 text-sky-300 border-sky-700/50',
  ready: 'bg-emerald-500/15 text-emerald-300 border-emerald-700/50',
  failed: 'bg-red-500/15 text-red-300 border-red-700/50',
};

export function DocumentList({ version = 0 }: { version?: number }) {
  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const list = await api.listDocuments();
    setDocuments(list);
    setLoading(false);
    const inFlight = list.some(
      (d) => d.status === 'uploading' || d.status === 'processing',
    );
    if (inFlight) {
      setTimeout(refresh, 2500);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  const onUploaded = useCallback(() => {
    void refresh();
  }, [refresh]);

  const remove = async (id: string) => {
    await api.deleteDocument(id);
    void refresh();
  };

  return (
    <div className="space-y-3">
      {loading && <p className="text-sm text-slate-500">Loading…</p>}
      {!loading && documents.length === 0 && (
        <p className="text-sm text-slate-500">No documents yet — upload your first PDF.</p>
      )}

      {documents.map((doc) => (
        <div key={doc.id} className="card flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">{doc.filename}</p>
            <p className="text-xs text-slate-500">
              {doc.chunkCount > 0 ? `${doc.chunkCount} chunks · ` : ''}
              {new Date(doc.createdAt).toLocaleString()}
            </p>
            {doc.error && <p className="mt-1 text-xs text-red-400">{doc.error}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${STATUS_STYLE[doc.status]}`}
            >
              {doc.status}
            </span>
            <button className="btn-ghost px-3 py-1 text-xs" onClick={() => void remove(doc.id)}>
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
