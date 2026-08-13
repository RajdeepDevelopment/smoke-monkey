'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ConversationDto, DocumentDto } from '@rag/contracts';
import { api } from '../../lib/api';
import { useAuth } from '../../components/AuthProvider';
import { PageScroll } from '../../components/PageScroll';

interface Health {
  status: string;
  postgres?: boolean;
  redis?: boolean;
  nats?: boolean;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function StatCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent: 'primary' | 'accent' | 'success';
}) {
  const ring =
    accent === 'primary' ? 'text-primary' : accent === 'accent' ? 'text-accent' : 'text-success';
  return (
    <div className="card flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</span>
      <span className={`text-2xl font-semibold ${ring}`}>{value}</span>
      {hint && <span className="text-xs text-ink-secondary">{hint}</span>}
    </div>
  );
}

function StatusChip({ ok, label }: { ok: boolean | undefined; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
        ok ? 'bg-success/10 text-success' : 'bg-error/10 text-error'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-success' : 'bg-error'}`} />
      {label}
    </span>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    if (!user) return;
    api
      .listConversations()
      .then(setConversations)
      .catch(() => setConversations([]));
    api
      .listDocuments()
      .then(setDocuments)
      .catch(() => setDocuments([]));
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, [user]);

  const readyDocs = documents.filter((d) => d.status === 'ready').length;
  const totalChunks = documents.reduce((sum, d) => sum + (d.chunkCount || 0), 0);
  const firstName = user?.name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? 'there';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <PageScroll>
      <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">
            {greeting}, {firstName}
          </h2>
          <p className="text-sm text-ink-secondary">Here&apos;s what&apos;s happening with your AI stack.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/chat" className="btn-primary">
            + New chat
          </Link>
          <Link href="/documents" className="btn-ghost">
            Upload documents
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total chats" value={conversations.length.toLocaleString()} hint="across all conversations" accent="primary" />
        <StatCard label="Documents" value={documents.length.toLocaleString()} hint={`${readyDocs} ready to query`} accent="accent" />
        <StatCard label="Chunks indexed" value={totalChunks.toLocaleString()} hint="available for retrieval" accent="success" />
        <StatCard label="Tokens used" value="—" hint="metrics coming soon" accent="primary" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Recent conversations</h3>
            <Link href="/chat" className="text-xs text-accent hover:underline">
              Open chat
            </Link>
          </div>
          {conversations.length === 0 ? (
            <p className="text-sm text-ink-muted">No conversations yet — start one from Chat.</p>
          ) : (
            <ul className="space-y-1">
              {conversations.slice(0, 6).map((c) => (
                <li key={c.id}>
                  <Link
                    href="/chat"
                    className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-800"
                  >
                    <span className="truncate text-sm text-ink-primary">{c.title}</span>
                    <span className="shrink-0 text-xs text-ink-muted">{fmtDate(c.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Knowledge activity</h3>
            <Link href="/documents" className="text-xs text-accent hover:underline">
              Manage
            </Link>
          </div>
          {documents.length === 0 ? (
            <p className="text-sm text-ink-muted">No documents yet — upload a PDF to get started.</p>
          ) : (
            <ul className="space-y-1">
              {documents.slice(0, 6).map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5">
                  <span className="truncate text-sm text-ink-primary">📄 {d.filename}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    {d.status === 'ready' ? (
                      <span className="text-xs text-success">Indexed</span>
                    ) : (
                      <span className="text-xs text-warning">{d.status}</span>
                    )}
                    <span className="text-xs text-ink-muted">{fmtDate(d.createdAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card">
        <h3 className="mb-3 text-sm font-semibold text-white">System status</h3>
        {health ? (
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip ok={health.postgres} label="Postgres" />
            <StatusChip ok={health.redis} label="Redis" />
            <StatusChip ok={health.nats} label="NATS" />
            <span className="ml-auto text-xs text-ink-muted">Overall: {health.status}</span>
          </div>
        ) : (
          <p className="text-sm text-ink-muted">Checking service health…</p>
        )}
      </div>
      </div>
    </PageScroll>
  );
}
