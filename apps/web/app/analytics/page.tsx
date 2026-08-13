'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MetricsSummaryDto } from '@rag/contracts';
import { api } from '../../lib/api';
import { PageScroll } from '../../components/PageScroll';

function pct(v: number | undefined): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function KpiCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent: 'primary' | 'accent' | 'success' | 'warning' | 'error';
}) {
  const color = {
    primary: 'text-primary',
    accent: 'text-accent',
    success: 'text-success',
    warning: 'text-warning',
    error: 'text-error',
  }[accent];
  return (
    <div className="card flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</span>
      <span className={`text-2xl font-semibold ${color}`}>{value}</span>
      {hint && <span className="text-xs text-ink-secondary">{hint}</span>}
    </div>
  );
}

function Bar({ label, value, max, accent }: { label: string; value: number; max: number; accent: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-xs text-ink-secondary">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-700">
        <div
          className={`h-full rounded-full ${accent}`}
          style={{ width: `${max > 0 ? Math.max(2, (value / max) * 100) : 0}%` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-ink-secondary">
        {value}
      </span>
    </div>
  );
}

export default function AnalyticsPage() {
  const [metrics, setMetrics] = useState<MetricsSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMetrics(await api.analyticsMetrics());
    } catch (err) {
      setError((err as Error).message || 'Analytics unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byMode = metrics?.byMode ?? {};
  const byProvider = metrics?.byProvider ?? {};
  const maxMode = Math.max(1, ...Object.values(byMode));
  const maxProvider = Math.max(1, ...Object.values(byProvider));
  const stage = metrics?.byStage;

  return (
    <PageScroll>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-white">Analytics</h1>
            <p className="text-sm text-ink-secondary">
              Request telemetry aggregated from Redis over the last{' '}
              {metrics ? `${(metrics.windowSeconds / 3600).toFixed(0)}h` : '24h'}.
            </p>
          </div>
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {!metrics && !error && <p className="text-sm text-ink-muted">Loading metrics…</p>}

        {metrics && (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <KpiCard
                label="Requests"
                value={metrics.requests.toLocaleString()}
                hint={`${Object.values(metrics.byType).length ? Object.entries(metrics.byType).map(([k, v]) => `${k} ${v}`).join(' · ') : 'no traffic yet'}`}
                accent="primary"
              />
              <KpiCard
                label="Error rate"
                value={pct(metrics.errorRate)}
                hint={`${metrics.errors.toLocaleString()} failed requests`}
                accent={metrics.errorRate > 0.05 ? 'error' : 'success'}
              />
              <KpiCard
                label="Cache hit rate"
                value={pct(metrics.cacheHitRate)}
                hint={`${metrics.cacheHits.toLocaleString()} of ${metrics.requests.toLocaleString()} served from cache`}
                accent="accent"
              />
              <KpiCard
                label="p95 latency"
                value={`${Math.round(metrics.totalMsPercentiles.p95)} ms`}
                hint={`avg ${Math.round(metrics.averageMs)} ms`}
                accent="warning"
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="card">
                <h3 className="mb-3 text-sm font-semibold text-white">Latency percentiles</h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {(
                    [
                      ['p50', metrics.totalMsPercentiles.p50],
                      ['p90', metrics.totalMsPercentiles.p90],
                      ['p95', metrics.totalMsPercentiles.p95],
                      ['p99', metrics.totalMsPercentiles.p99],
                    ] as const
                  ).map(([label, ms]) => (
                    <div key={label} className="rounded-lg border border-surface-700 bg-surface-800/60 p-3">
                      <span className="text-xs text-ink-muted">{label}</span>
                      <div className="text-lg font-semibold text-white">
                        {Math.round(ms)} <span className="text-xs text-ink-muted">ms</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="card">
                <h3 className="mb-3 text-sm font-semibold text-white">Average stage latency</h3>
                {stage ? (
                  <div className="space-y-2.5">
                    <Bar label="Embedding" value={Math.round(stage.embeddingMs)} max={Math.max(1, Math.round(stage.llmGenerationMs))} accent="bg-accent" />
                    <Bar label="Retrieval" value={Math.round(stage.retrievalMs)} max={Math.max(1, Math.round(stage.llmGenerationMs))} accent="bg-accent" />
                    <Bar label="Rerank" value={Math.round(stage.rerankerMs)} max={Math.max(1, Math.round(stage.llmGenerationMs))} accent="bg-warning" />
                    <Bar label="TTFT" value={Math.round(stage.llmTtftMs)} max={Math.max(1, Math.round(stage.llmGenerationMs))} accent="bg-primary" />
                    <Bar label="Generation" value={Math.round(stage.llmGenerationMs)} max={Math.max(1, Math.round(stage.llmGenerationMs))} accent="bg-primary" />
                  </div>
                ) : (
                  <p className="text-sm text-ink-muted">No timing data yet.</p>
                )}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="card">
                <h3 className="mb-3 text-sm font-semibold text-white">By mode</h3>
                <div className="space-y-2.5">
                  {Object.keys(byMode).length === 0 && (
                    <p className="text-sm text-ink-muted">No requests yet.</p>
                  )}
                  {Object.entries(byMode)
                    .sort((a, b) => b[1] - a[1])
                    .map(([mode, count]) => (
                      <Bar key={mode} label={mode} value={count} max={maxMode} accent="bg-accent" />
                    ))}
                </div>
              </div>

              <div className="card">
                <h3 className="mb-3 text-sm font-semibold text-white">By provider</h3>
                <div className="space-y-2.5">
                  {Object.keys(byProvider).length === 0 && (
                    <p className="text-sm text-ink-muted">No requests yet.</p>
                  )}
                  {Object.entries(byProvider)
                    .sort((a, b) => b[1] - a[1])
                    .map(([provider, count]) => (
                      <Bar key={provider} label={provider} value={count} max={maxProvider} accent="bg-primary" />
                    ))}
                </div>
              </div>
            </div>

            {metrics.recentErrors.length > 0 && (
              <div className="card">
                <h3 className="mb-3 text-sm font-semibold text-white">Recent errors</h3>
                <ul className="space-y-1.5">
                  {metrics.recentErrors.map((msg, i) => (
                    <li key={i} className="truncate rounded-lg bg-error/5 px-3 py-1.5 text-xs text-red-300">
                      {msg}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </PageScroll>
  );
}
