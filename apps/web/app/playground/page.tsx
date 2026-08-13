'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DocumentDto, RetrieveResponseDto } from '@rag/contracts';
import { api } from '../../lib/api';
import { useAuth } from '../../components/AuthProvider';
import { PageScroll } from '../../components/PageScroll';

const MODES = [
  { id: 'fast', label: 'Fast', desc: '1 embedding call, no rewriting, no rerank, small topK' },
  { id: 'balanced', label: 'Balanced', desc: 'rerank on, medium topK (default)' },
  { id: 'deep', label: 'Deep', desc: 'multi-query + HyDE + rerank, largest topK' },
] as const;

function TimingBar({ label, ms, accent }: { label: string; ms: number; accent: string }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-ink-muted">{label}</span>
        <span className="font-mono tabular-nums text-ink-secondary">{Math.round(ms)} ms</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-surface-700">
        <div className={`h-full rounded-full ${accent}`} style={{ width: `${Math.min(100, ms)}%` }} />
      </div>
    </div>
  );
}

export default function PlaygroundPage() {
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'fast' | 'balanced' | 'deep'>('balanced');
  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<RetrieveResponseDto | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (user) {
      api
        .listDocuments()
        .then((docs) => setDocuments(docs.filter((d) => d.status === 'ready')))
        .catch(() => setDocuments([]));
    }
  }, [user]);

  const run = useCallback(async () => {
    const text = query.trim();
    if (!text || running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.playgroundRetrieve({
        message: text,
        mode,
        documentIds: selectedDocIds.size > 0 ? [...selectedDocIds] : undefined,
      });
      setResult(res);
      setExpanded(new Set());
    } catch (err) {
      setError((err as Error).message || 'Retrieval failed');
    } finally {
      setRunning(false);
    }
  }, [query, running, mode, selectedDocIds]);

  const totalMs = result?.timings.total_ms ?? 0;
  const maxScore = useMemo(
    () => Math.max(...(result?.chunks.map((c) => c.score) ?? [0]), 0),
    [result],
  );

  return (
    <PageScroll>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-white">Retrieval playground</h1>
          <p className="text-sm text-ink-secondary">
            Run the hybrid retrieval pipeline directly — no generation. Inspect scores, sources
            and per-stage latency.
          </p>
        </div>

        <div className="card space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-secondary">Query</label>
            <textarea
              className="input min-h-[88px] resize-y"
              placeholder="e.g. What does the lease say about early termination?"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void run();
                }
              }}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-ink-secondary">Mode:</span>
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                title={m.desc}
                className={`rounded-full border px-2.5 py-1 transition-colors ${
                  mode === m.id
                    ? 'border-primary/50 bg-primary-subtle text-white'
                    : 'border-surface-600 text-ink-secondary hover:text-white'
                }`}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>

          {documents.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
              <span className="mr-1 font-medium text-ink-secondary">Scope:</span>
              <button
                type="button"
                className={`rounded-full border px-2 py-0.5 transition-colors ${
                  selectedDocIds.size === 0
                    ? 'border-primary/50 bg-primary-subtle text-white'
                    : 'border-surface-600 text-ink-secondary hover:text-white'
                }`}
                onClick={() => setSelectedDocIds(new Set())}
              >
                All documents
              </button>
              {documents.map((doc) => {
                const active = selectedDocIds.has(doc.id);
                return (
                  <button
                    key={doc.id}
                    type="button"
                    className={`max-w-[180px] truncate rounded-full border px-2 py-0.5 transition-colors ${
                      active
                        ? 'border-accent/50 bg-accent/10 text-accent'
                        : 'border-surface-600 text-ink-secondary hover:text-white'
                    }`}
                    onClick={() =>
                      setSelectedDocIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(doc.id)) next.delete(doc.id);
                        else next.add(doc.id);
                        return next;
                      })
                    }
                  >
                    {doc.filename}
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button className="btn-primary" onClick={() => void run()} disabled={running || !query.trim()}>
              {running ? 'Retrieving…' : 'Run retrieval'}
            </button>
            <span className="text-xs text-ink-muted">⌘/Ctrl + Enter</span>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {result && (
          <>
            <div className="grid gap-4 lg:grid-cols-4">
              <div className="card flex flex-col gap-1">
                <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">Total</span>
                <span className="text-2xl font-semibold text-primary">
                  {Math.round(totalMs)} <span className="text-sm text-ink-muted">ms</span>
                </span>
                <span className="text-xs text-ink-secondary">
                  {result.chunks.length} chunks · mode {result.mode}
                </span>
              </div>
              <div className="card flex flex-col gap-1">
                <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">Embedding</span>
                <span className="text-2xl font-semibold text-accent">
                  {Math.round(result.timings.embedding_ms)}{' '}
                  <span className="text-sm text-ink-muted">ms</span>
                </span>
                <span className="text-xs text-ink-secondary">query vectors</span>
              </div>
              <div className="card flex flex-col gap-1">
                <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">Retrieval</span>
                <span className="text-2xl font-semibold text-accent">
                  {Math.round(result.timings.retrieval_ms)}{' '}
                  <span className="text-sm text-ink-muted">ms</span>
                </span>
                <span className="text-xs text-ink-secondary">
                  rerank {Math.round(result.timings.reranker_ms)} ms
                </span>
              </div>
              <div className="card flex flex-col gap-1">
                <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">Cache</span>
                <span
                  className={`text-2xl font-semibold ${
                    result.retrievalCacheHit ? 'text-success' : 'text-ink-secondary'
                  }`}
                >
                  {result.retrievalCacheHit ? 'HIT' : 'miss'}
                </span>
                <span className="text-xs text-ink-secondary">retrieval result cache</span>
              </div>
            </div>

            <div className="card space-y-2">
              <h3 className="text-sm font-semibold text-white">Timing breakdown</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <TimingBar label="Embedding" ms={result.timings.embedding_ms} accent="bg-accent" />
                <TimingBar label="Retrieval" ms={result.timings.retrieval_ms} accent="bg-accent" />
                <TimingBar label="Rerank" ms={result.timings.reranker_ms} accent="bg-warning" />
                <TimingBar label="Other" ms={Math.max(0, totalMs - result.timings.embedding_ms - result.timings.retrieval_ms - result.timings.reranker_ms)} accent="bg-surface-600" />
                <TimingBar label="Total" ms={totalMs} accent="bg-primary" />
              </div>
            </div>

            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white">Retrieved chunks</h3>
                <span className="text-xs text-ink-muted">
                  {result.chunks.length} results · score relative to top hit
                </span>
              </div>
              <div className="space-y-2.5">
                {result.chunks.map((c) => {
                  const pct = Math.round(Math.max(0, Math.min(1, c.score)) * 100);
                  const isOpen = expanded.has(c.id);
                  return (
                    <div key={c.id} className="card space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-surface-700 text-[11px] text-ink-muted">
                          {c.rank}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-white" title={c.documentName}>
                          {c.documentName}
                        </span>
                        <span
                          className={`shrink-0 text-xs font-semibold tabular-nums ${
                            pct >= 80 ? 'text-success' : pct >= 50 ? 'text-warning' : 'text-ink-muted'
                          }`}
                        >
                          {pct}%
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
                        {c.page && <span className="text-accent">p.{c.page}</span>}
                        {c.section && <span className="truncate">{c.section}</span>}
                        {c.denseScore != null && (
                          <span className="rounded bg-surface-800 px-1.5 py-0.5 font-mono">
                            dense {c.denseScore.toFixed(3)}
                          </span>
                        )}
                        {c.sparseScore != null && (
                          <span className="rounded bg-surface-800 px-1.5 py-0.5 font-mono">
                            sparse {c.sparseScore.toFixed(3)}
                          </span>
                        )}
                        <button
                          type="button"
                          className="ml-auto text-accent hover:underline"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(c.id)) next.delete(c.id);
                              else next.add(c.id);
                              return next;
                            })
                          }
                        >
                          {isOpen ? 'Collapse' : 'Expand'}
                        </button>
                      </div>
                      <p
                        className={`whitespace-pre-wrap text-xs leading-relaxed text-ink-secondary ${
                          isOpen ? '' : 'line-clamp-3'
                        }`}
                      >
                        {c.content}
                      </p>
                      {!isOpen && (
                        <div
                          className="h-1 overflow-hidden rounded-full bg-surface-700"
                          title={`relative relevance ${pct}%`}
                        >
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${Math.round((c.score / maxScore) * 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
                {result.chunks.length === 0 && (
                  <p className="text-sm text-ink-muted">No chunks matched — try a different query.</p>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </PageScroll>
  );
}
