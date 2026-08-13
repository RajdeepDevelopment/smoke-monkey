'use client';

import { useRef, useState } from 'react';
import type { DocumentDto } from '@rag/contracts';
import { api } from '../lib/api';

export function DocumentUpload({ onUploaded }: { onUploaded: (doc: DocumentDto) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setError('Only PDF files are supported');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const doc = await api.uploadDocument(file);
      onUploaded(doc);
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="card">
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn-primary"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? 'Uploading…' : 'Upload PDF'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => void handleFile(e.target.files?.[0])}
        />
        <span className="text-xs text-slate-500">
          PDF only · up to 10MB · processed async (parse → chunk → embed → index)
        </span>
      </div>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}
