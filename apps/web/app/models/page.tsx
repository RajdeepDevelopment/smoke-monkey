'use client';

import { useEffect, useState } from 'react';
import type { CatalogModel, ModelsResponseDto, ModelPreset } from '@rag/contracts';
import { api } from '../../lib/api';
import { PageScroll } from '../../components/PageScroll';

function Stars({ rating }: { rating: number }) {
  return (
    <span className="text-amber-300">
      {'★'.repeat(rating)}
      <span className="text-slate-700">{'★'.repeat(5 - rating)}</span>
    </span>
  );
}

function FreeBadge({ isFree }: { isFree?: boolean }) {
  if (!isFree) return null;
  return (
    <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
      free
    </span>
  );
}

function ModelRow({ m }: { m: CatalogModel }) {
  return (
    <tr className="border-b border-surface-800 last:border-0">
      <td className="px-4 py-2.5 text-slate-200">
        {m.name}
        <FreeBadge isFree={m.isFree} />
      </td>
      <td className="px-4 py-2.5 font-mono text-xs text-slate-300">{m.id}</td>
      <td className="px-4 py-2.5 text-xs text-slate-400">{m.provider}</td>
      <td className="px-4 py-2.5 text-xs text-slate-400">{m.dims ?? '—'}</td>
      {m.notes && <td className="px-4 py-2.5 text-xs text-slate-500">{m.notes}</td>}
    </tr>
  );
}

export default function ModelsPage() {
  const [models, setModels] = useState<ModelsResponseDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .fetchModels()
      .then(setModels)
      .catch((err) => setError((err as Error).message));
  }, []);

  const chatPresets = (models?.presets ?? []).filter((p) =>
    ['main', 'reasoning', 'coding', 'flagship', 'efficient', 'fast', 'vision'].includes(p.role),
  );
  const retrievalPresets = (models?.presets ?? []).filter((p) =>
    ['embed', 'embed-multi', 'rerank'].includes(p.role),
  );

  return (
    <PageScroll>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-white">Models</h1>
          <p className="text-sm text-ink-secondary">
            The model catalog is data-driven — edit{' '}
            <code className="rounded bg-surface-800 px-1 py-0.5 text-xs text-cyan-200">
              apps/rag-service/src/config/model_catalog.json
            </code>{' '}
            to change recommendations without touching code.
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {!models && !error && <p className="text-sm text-ink-muted">Loading models…</p>}

        {models && (
          <>
            <section className="grid gap-4 lg:grid-cols-3">
              <div className="card text-sm">
                <p className="text-xs uppercase tracking-wide text-ink-muted">Default chat</p>
                <p className="mt-1 font-mono text-xs text-slate-200">
                  {models.defaultProvider}
                </p>
                <p className="mt-1 text-xs text-slate-500">Used when no provider is selected</p>
              </div>
              <div className="card text-sm">
                <p className="text-xs uppercase tracking-wide text-ink-muted">Embedding layer</p>
                <p className="mt-1 truncate font-mono text-xs text-slate-200">
                  {models.embedding.provider}: {models.embedding.model}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {models.embedding.dims} dims · fixed by the pgvector index
                </p>
              </div>
              <div className="card text-sm">
                <p className="text-xs uppercase tracking-wide text-ink-muted">Rerank layer</p>
                <p className="mt-1 truncate font-mono text-xs text-slate-200">
                  {models.rerank.enabled
                    ? `${models.rerank.provider}: ${models.rerank.model}`
                    : 'disabled'}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Re-scores retrieval results before the LLM
                </p>
              </div>
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
                Providers
              </h2>
              <div className="card space-y-3 p-0">
                {models.providers.map((p) => (
                  <div key={p.id} className="border-b border-surface-800 px-4 py-3 last:border-0">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-sm font-medium text-white">{p.label}</span>
                      <span className="text-[11px] text-ink-muted">{p.id}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {p.models.map((m) => (
                        <span
                          key={m}
                          className="max-w-[260px] truncate rounded-full border border-surface-600 px-2 py-0.5 font-mono text-[11px] text-ink-secondary"
                        >
                          {m}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {chatPresets.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
                  Recommended chat models
                </h2>
                <div className="card overflow-x-auto p-0">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-surface-700 text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-4 py-2.5">Role</th>
                        <th className="px-4 py-2.5">Model</th>
                        <th className="px-4 py-2.5">Provider</th>
                        <th className="px-4 py-2.5">Rating</th>
                        <th className="px-4 py-2.5">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chatPresets.map((p: ModelPreset) => (
                        <tr key={p.role} className="border-b border-surface-800 last:border-0">
                          <td className="px-4 py-2.5 text-slate-200">{p.label}</td>
                          <td className="px-4 py-2.5 font-mono text-xs text-slate-300">
                            {p.model} <FreeBadge isFree={p.isFree} />
                          </td>
                          <td className="px-4 py-2.5 text-xs text-slate-400">{p.providerLabel}</td>
                          <td className="px-4 py-2.5 text-xs">
                            <Stars rating={p.rating} />
                          </td>
                          <td className="px-4 py-2.5 text-xs text-slate-500">{p.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {retrievalPresets.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
                  Recommended retrieval models
                </h2>
                <div className="card overflow-x-auto p-0">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-surface-700 text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-4 py-2.5">Purpose</th>
                        <th className="px-4 py-2.5">Model</th>
                        <th className="px-4 py-2.5">Provider</th>
                        <th className="px-4 py-2.5">Dims</th>
                        <th className="px-4 py-2.5">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {retrievalPresets.map((p: ModelPreset) => (
                        <tr key={p.role} className="border-b border-surface-800 last:border-0">
                          <td className="px-4 py-2.5 text-slate-200">{p.label}</td>
                          <td className="px-4 py-2.5 font-mono text-xs text-slate-300">
                            {p.model} <FreeBadge isFree={p.isFree} />
                          </td>
                          <td className="px-4 py-2.5 text-xs text-slate-400">{p.providerLabel}</td>
                          <td className="px-4 py-2.5 text-xs text-slate-400">{p.dims ?? '—'}</td>
                          <td className="px-4 py-2.5 text-xs text-slate-500">{p.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section className="space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
                Embedding model catalog
              </h2>
              <div className="card overflow-x-auto p-0">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-surface-700 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5">Model</th>
                      <th className="px-4 py-2.5">ID</th>
                      <th className="px-4 py-2.5">Provider</th>
                      <th className="px-4 py-2.5">Dims</th>
                      <th className="px-4 py-2.5">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.catalog.embeddingModels.map((m) => (
                      <ModelRow key={m.id} m={m} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
                Rerank model catalog
              </h2>
              <div className="card overflow-x-auto p-0">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-surface-700 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5">Model</th>
                      <th className="px-4 py-2.5">ID</th>
                      <th className="px-4 py-2.5">Provider</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.catalog.rerankModels.map((m) => (
                      <tr key={m.id} className="border-b border-surface-800 last:border-0">
                        <td className="px-4 py-2.5 text-slate-200">{m.name}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-slate-300">{m.id}</td>
                        <td className="px-4 py-2.5 text-xs text-slate-400">{m.provider}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </PageScroll>
  );
}
