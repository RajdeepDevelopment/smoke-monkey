'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CitationDto, ConversationDto, DocumentDto, ModelProvider, UserKeyDto, WebSourceDto } from '@rag/contracts';
import { api } from '../lib/api';
import { useAuth } from './AuthProvider';
import { BrandIcon } from './BrandIcon';
import { Markdown } from './Markdown';
import { MessageBubble, type BubbleMessage } from './MessageBubble';
import { SidebarNav } from './Sidebar';

const STREAM_ID = 'tmp-assistant';
const STREAM_THROTTLE_MS = 40;

let seq = 0;
const nextId = () => `m-${Date.now()}-${seq++}`;

const ICON_PROPS = {
  className: 'h-4 w-4',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const PAPERCLIP = (
  <svg {...ICON_PROPS}>
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

const BOOK = (
  <svg {...ICON_PROPS}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
);

const ARROW_UP = (
  <svg {...ICON_PROPS}>
    <path d="m5 12 7-7 7 7" />
    <path d="M12 19V5" />
  </svg>
);

const SQUARE = (
  <svg {...ICON_PROPS}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </svg>
);

const MORE = (
  <svg {...ICON_PROPS}>
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </svg>
);

const KEY = (
  <svg {...ICON_PROPS}>
    <circle cx="7.5" cy="15.5" r="5.5" />
    <path d="m21 2-9.6 9.6" />
    <path d="m15.5 7.5 3 3L22 7l-3-3" />
  </svg>
);

const SUGGESTED_PROMPTS = [
  'Ask about my documents',
  'What do you know about me?',
  'Summarize my uploaded PDFs',
  'Explain how hybrid retrieval works',
];

/** Providers a user can bring their own key for, shown in the composer's
 *  inline key mini-bar. Grouped by what the key is used for. */
const KEY_PROVIDERS = [
  { id: 'openrouter', label: 'OpenRouter', group: 'Chat models', placeholder: 'sk-or-v1-…', getKeyUrl: 'https://openrouter.ai/keys' },
  { id: 'nvidia', label: 'NVIDIA NIM', group: 'Chat models', placeholder: 'nvapi-…', getKeyUrl: 'https://build.nvidia.com' },
  { id: 'tavily', label: 'Tavily', group: 'Web search', placeholder: 'tvly-…', getKeyUrl: 'https://app.tavily.com' },
  { id: 'brave', label: 'Brave Search', group: 'Web search', placeholder: 'BSA…', getKeyUrl: 'https://brave.com/search/api/' },
  { id: 'bing', label: 'Bing Web Search', group: 'Web search', placeholder: '32-character key', getKeyUrl: 'https://portal.azure.com' },
];

const CHAT_KEY_PROVIDERS = new Set(['openrouter', 'nvidia']);

interface StageItem {
  label: string;
  done: boolean;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function SourceScore({ score }: { score: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
  const color = pct >= 80 ? 'text-success' : pct >= 50 ? 'text-warning' : 'text-ink-muted';
  return <span className={`shrink-0 text-[11px] font-semibold tabular-nums ${color}`}>{pct}%</span>;
}

/** Loading card shown below the user's latest message while the AI works. */
function AssistantLoadingCard({ content, stages }: { content: string; stages: StageItem[] }) {
  return (
    <div className="flex w-full justify-start">
      <div className="flex max-w-[85%] items-start gap-2.5">
        <BrandIcon size={24} className="mt-0.5 rounded-full" />
        <div className="min-w-0">
          <p className="mb-1.5 text-xs font-semibold text-ink-secondary">Smoke Monkey</p>
          {stages.length > 0 && (
            <ul className="mb-2.5 space-y-1">
              {stages.map((s) => (
                <li
                  key={s.label}
                  className={`flex items-center gap-2 text-xs ${
                    s.done ? 'text-ink-muted' : 'text-ink-primary'
                  }`}
                >
                  <span className={`w-3 shrink-0 ${s.done ? 'text-success' : 'text-primary'}`}>
                    {s.done ? '✓' : '●'}
                  </span>
                  {s.label}
                </li>
              ))}
            </ul>
          )}
          {content && (
            <div className="rounded-xl border border-surface-600 bg-surface-800 px-4 py-3 text-sm leading-relaxed text-ink-primary">
              <Markdown content={content} />
              <span className="ml-0.5 animate-pulse text-ink-muted">▍</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Compact key reminder bar shown inside the composer when the selected
 *  provider has no saved user key. Lets the user paste one right here;
 *  everything else lives in Settings. */
function ComposerKeyBar({
  provider,
  providerLabel,
  onSaved,
}: {
  provider: string;
  providerLabel: string;
  onSaved: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.saveKey(provider, value.trim());
      setValue('');
      onSaved();
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-surface-600/50 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[11px] font-medium text-warning">
          No {providerLabel} key
        </span>
        <input
          type="password"
          className="input h-8 min-w-0 flex-1 px-2 py-1 font-mono text-xs"
          placeholder={`Paste ${providerLabel} key…`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
        />
        <button
          type="button"
          className="btn-primary h-8 shrink-0 px-3 text-xs"
          disabled={busy || !value.trim()}
          onClick={() => void save()}
        >
          Save
        </button>
        <Link href="/settings" className="shrink-0 text-[11px] text-ink-muted hover:text-white hover:underline">
          More options in Settings →
        </Link>
      </div>
      {msg && (
        <p className={`mt-1.5 text-xs ${msg.kind === 'ok' ? 'text-success' : 'text-red-400'}`}>{msg.text}</p>
      )}
    </div>
  );
}

/** Dropdown panel opened from the composer's "Keys" button — lets the user add
 *  LLM and web-search keys inline without leaving the chat. */
function KeyManagerPanel({
  savedKeys,
  onChanged,
}: {
  savedKeys: UserKeyDto[];
  onChanged: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const savedFor = (id: string) => savedKeys.find((k) => k.provider === id);

  const save = async (id: string, label: string) => {
    const value = (values[id] ?? '').trim();
    if (!value) return;
    setBusyId(id);
    setMsg(null);
    try {
      await api.saveKey(id, value);
      setValues((v) => ({ ...v, [id]: '' }));
      setMsg({ kind: 'ok', text: `${label} key saved.` });
      onChanged();
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  };

  const groups = ['Chat models', 'Web search'] as const;

  return (
    <div className="absolute bottom-full left-2 z-30 mb-2 w-80 rounded-xl border border-surface-600 bg-surface-900 p-3 shadow-2xl">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">API keys</p>
      <p className="mb-2 text-[11px] text-ink-muted">
        Add your own keys here — they are used for your chat and web search requests.
      </p>
      <div className="max-h-72 space-y-3 overflow-y-auto pr-0.5">
        {groups.map((group) => (
          <div key={group}>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{group}</p>
            <div className="space-y-2">
              {KEY_PROVIDERS.filter((p) => p.group === group).map((p) => {
                const saved = savedFor(p.id);
                return (
                  <div key={p.id} className="rounded-lg border border-surface-700 bg-surface-800/60 p-2">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-slate-200">{p.label}</span>
                      {saved ? (
                        <span className="rounded-full bg-emerald-900/50 px-2 py-0.5 text-[10px] text-emerald-300">
                          {saved.keyPrefix}…{saved.last4}
                        </span>
                      ) : (
                        <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] text-warning">no key</span>
                      )}
                    </div>
                    <form
                      className="flex gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void save(p.id, p.label);
                      }}
                    >
                      <input
                        className="input h-8 min-w-0 flex-1 px-2 py-1 font-mono text-xs"
                        type="password"
                        placeholder={saved ? 'Replace…' : p.placeholder}
                        value={values[p.id] ?? ''}
                        onChange={(e) => setValues((v) => ({ ...v, [p.id]: e.target.value }))}
                        autoComplete="off"
                      />
                      <button
                        type="submit"
                        className="btn-primary h-8 shrink-0 px-2.5 text-xs"
                        disabled={busyId === p.id || !(values[p.id] ?? '').trim()}
                      >
                        {busyId === p.id ? 'Saving…' : 'Save'}
                      </button>
                      <a
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-surface-600 text-xs text-ink-muted transition-colors hover:bg-surface-800 hover:text-white"
                        href={p.getKeyUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={`Get ${p.label} key`}
                      >
                        ↗
                      </a>
                    </form>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-surface-700 pt-2">
        <span className="text-[11px] text-ink-muted">Key status</span>
        <Link href="/settings" className="text-[11px] text-accent hover:underline">
          More options in Settings →
        </Link>
      </div>
      {msg && (
        <p className={`mt-1.5 text-xs ${msg.kind === 'ok' ? 'text-success' : 'text-red-400'}`}>{msg.text}</p>
      )}
    </div>
  );
}

export function ChatPanel({ initialConversationId }: { initialConversationId?: string }) {
  const { user, loading: authLoading, logout } = useAuth();
  const router = useRouter();
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BubbleMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [stages, setStages] = useState<StageItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [provider, setProvider] = useState('ollama');
  const [model, setModel] = useState('');
  const [savedKeys, setSavedKeys] = useState<UserKeyDto[]>([]);
  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerCitations, setDrawerCitations] = useState<CitationDto[]>([]);
  const [drawerWebSources, setDrawerWebSources] = useState<WebSourceDto[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const initRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const streamBufferRef = useRef('');
  const lastStreamFlushRef = useRef(0);

  const isFresh = messages.length === 0;

  const keyedProviders = new Set(savedKeys.map((k) => k.provider));
  const refreshKeys = useCallback(async () => {
    try {
      const { keys } = await api.listKeys();
      setSavedKeys(keys);
    } catch {
      setSavedKeys([]);
    }
  }, []);

  useEffect(() => {
    if (!user || initRef.current) return;
    initRef.current = true;
    void refreshConversations();
    if (initialConversationId) {
      void openConversation(initialConversationId).catch(() => {
        setActiveId(null);
        setMessages([]);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, initialConversationId]);

  useEffect(() => {
    api
      .fetchModels()
      .then((res) => {
        setProviders(res.providers);
        const preferred =
          res.providers.find((p) => p.id === 'nvidia') ??
          res.providers.find((p) => p.id === res.defaultProvider) ??
          res.providers[0];
        setProvider(preferred?.id ?? 'ollama');
        setModel(preferred?.models[0] ?? '');
      })
      .catch(() => setProviders([]));
    void refreshKeys();
    if (user) {
      api
        .listDocuments()
        .then((docs) => setDocuments(docs.filter((d) => d.status === 'ready')))
        .catch(() => setDocuments([]));
    }
  }, [user]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  useEffect(() => {
    router.replace(activeId ? `/chat?c=${activeId}` : '/chat', { scroll: false });
  }, [activeId, router]);

  const refreshConversations = useCallback(async () => {
    const list = await api.listConversations();
    setConversations(list);
    if (activeId && !list.some((c) => c.id === activeId)) setActiveId(null);
  }, [activeId]);

  const openConversation = useCallback(
    async (id: string) => {
      if (streaming) return;
      setActiveId(id);
      setError(null);
      setStages([]);
      setDrawerOpen(false);
      stickToBottomRef.current = true;
      const history = await api.getMessages(id);
      setMessages(
        history.map((m) => ({
          id: m.id,
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content,
          citations: m.citations,
          webSources: m.webSources,
          confidence: m.confidence,
        })),
      );
    },
    [streaming],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      if (streaming) return;
      try {
        await api.deleteConversation(id);
      } catch {
        return;
      }
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
        setDrawerOpen(false);
      }
      void refreshConversations();
    },
    [streaming, activeId, refreshConversations],
  );

  const newChat = useCallback(() => {
    if (streaming) return;
    setActiveId(null);
    setMessages([]);
    setError(null);
    setStages([]);
    setDrawerOpen(false);
    setDrawerWebSources([]);
    setMenuOpen(false);
    setInput('');
    stickToBottomRef.current = true;
  }, [streaming]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const patchStreaming = useCallback(
    (patch: Partial<BubbleMessage>) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === STREAM_ID);
        if (idx === -1) return prev;
        if (
          prev[idx].content === (patch.content ?? prev[idx].content) &&
          prev[idx].citations === (patch.citations ?? prev[idx].citations) &&
          prev[idx].webSources === (patch.webSources ?? prev[idx].webSources) &&
          prev[idx].pending === (patch.pending ?? prev[idx].pending)
        ) {
          return prev;
        }
        const next = prev.slice();
        next[idx] = { ...prev[idx], ...patch };
        return next;
      });
    },
    [],
  );

  const flushStream = useCallback(() => {
    patchStreaming({ content: streamBufferRef.current });
    lastStreamFlushRef.current = performance.now();
  }, [patchStreaming]);

  const pushStage = useCallback((label: string) => {
    setStages((prev) => {
      const clean = label.replace(/…$/, '').replace(/\.\.\.$/, '').trim();
      if (!clean) return prev;
      if (prev.length && prev[prev.length - 1].label === clean) return prev;
      return [...prev.map((s) => ({ ...s, done: true })), { label: clean, done: false }];
    });
  }, []);

  const completeStages = useCallback(() => {
    setStages((prev) => prev.map((s) => ({ ...s, done: true })));
  }, []);

  const send = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? input).trim();
      if (!text || streaming) return;

      setInput('');
      setError(null);
      setNotice(null);
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'user', content: text },
        { id: STREAM_ID, role: 'assistant', content: '', pending: true },
      ]);
      setStreaming(true);
      setStages([{ label: 'Understanding your question', done: false }]);
      stickToBottomRef.current = true;
      streamBufferRef.current = '';
      lastStreamFlushRef.current = 0;

      const controller = new AbortController();
      abortRef.current = controller;

      let assistantContent = '';
      let citations: CitationDto[] | null = null;
      let webSources: WebSourceDto[] | null = null;
      let confidence = 0;

      try {
        for await (const event of api.streamChat(
          text,
          activeId ?? undefined,
          controller.signal,
          provider,
          model,
          selectedDocIds.size > 0 ? [...selectedDocIds] : undefined,
        )) {
          switch (event.type) {
            case 'meta':
              setActiveId((prev) => prev ?? event.conversationId);
              break;
            case 'sources':
              citations = event.citations;
              patchStreaming({ citations });
              break;
            case 'web_sources':
              webSources = event.sources;
              patchStreaming({ webSources });
              break;
            case 'status':
              pushStage(event.label);
              break;
            case 'chunk':
              completeStages();
              assistantContent += event.text;
              streamBufferRef.current = assistantContent;
              if (performance.now() - lastStreamFlushRef.current >= STREAM_THROTTLE_MS) {
                flushStream();
              }
              break;
            case 'done':
              confidence = event.confidence ?? 0;
              citations = event.citations ?? citations;
              webSources = event.webSources ?? webSources;
              break;
            case 'error':
              throw new Error(event.message);
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message || 'Something went wrong');
        }
      } finally {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === STREAM_ID
              ? {
                  ...m,
                  id: nextId(),
                  content: assistantContent || streamBufferRef.current || m.content,
                  citations: citations ?? m.citations,
                  webSources: webSources ?? m.webSources,
                  confidence,
                  pending: false,
                }
              : m,
          ),
        );
        setStreaming(false);
        setStages([]);
        void refreshConversations();
      }
    },
    [input, streaming, activeId, refreshConversations, provider, model, selectedDocIds, pushStage, completeStages, flushStream, patchStreaming],
  );

  // ── Sources drawer ────────────────────────────────────────────────────────
  const lastCited = [...messages]
    .reverse()
    .find(
      (m) =>
        m.role === 'assistant' &&
        ((m.citations?.length ?? 0) > 0 || (m.webSources?.length ?? 0) > 0),
    );
  const sourceCount = (lastCited?.citations ?? []).filter((c) => c.text && c.text.trim().length > 0).length;
  const webSourceCount = (lastCited?.webSources ?? []).filter((s) => s.url || s.content).length;

  const openSources = useCallback((citations: CitationDto[], webSources: WebSourceDto[]) => {
    setDrawerCitations(citations);
    setDrawerWebSources(webSources);
    setDrawerOpen(true);
  }, []);

  const toggleSources = useCallback(() => {
    setDrawerOpen((open) => {
      if (!open) {
        setDrawerCitations(lastCited?.citations ?? []);
        setDrawerWebSources(lastCited?.webSources ?? []);
        return true;
      }
      return false;
    });
  }, [lastCited]);

  const attachFile = useCallback(
    async (file: File) => {
      if (!file) return;
      try {
        const doc = await api.uploadDocument(file);
        setNotice(`Uploaded ${doc.filename} — indexing in progress.`);
        const docs = await api.listDocuments();
        setDocuments(docs.filter((d) => d.status === 'ready'));
        setSelectedDocIds((prev) => new Set(prev).add(doc.id));
        setScopeOpen(false);
      } catch (err) {
        setError((err as Error).message || 'Upload failed');
      }
    },
    [],
  );

  if (authLoading) return <div className="text-sm text-ink-muted">Loading…</div>;
  if (!user) {
    return (
      <div className="card mx-auto max-w-lg text-center">
        <p className="mb-4 text-ink-secondary">Sign in to start chatting with your documents.</p>
        <a href="/login" className="btn-primary">
          Sign in
        </a>
      </div>
    );
  }

  const userName = user.name || user.email;

  // ── Composer (shared by fresh + active states) ────────────────────────────
  const composerCard = (
    <div className="relative mx-auto w-full max-w-3xl">
      {scopeOpen && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setScopeOpen(false)} />
          <div className="absolute bottom-full left-2 z-30 mb-2 w-80 rounded-xl border border-surface-600 bg-surface-900 p-3 shadow-2xl">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
              Knowledge Base
            </p>
            <p className="mb-2 text-[11px] text-ink-muted">
              Search the selected documents. Nothing selected = all documents.
            </p>
            <button
              type="button"
              className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                selectedDocIds.size === 0 ? 'bg-primary-subtle text-white' : 'text-ink-secondary hover:bg-surface-800'
              }`}
              onClick={() => {
                setSelectedDocIds(new Set());
                setScopeOpen(false);
              }}
            >
              <span
                className={`flex h-4 w-4 items-center justify-center rounded border ${
                  selectedDocIds.size === 0 ? 'border-primary bg-primary' : 'border-surface-600'
                }`}
              >
                {selectedDocIds.size === 0 && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" className="h-3 w-3">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </span>
              All documents
            </button>
            <div className="max-h-56 space-y-0.5 overflow-y-auto">
              {documents.map((doc) => {
                const active = selectedDocIds.has(doc.id);
                return (
                  <button
                    key={doc.id}
                    type="button"
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                      active ? 'bg-primary-subtle text-white' : 'text-ink-secondary hover:bg-surface-800'
                    }`}
                    onClick={() => {
                      setSelectedDocIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(doc.id)) next.delete(doc.id);
                        else next.add(doc.id);
                        return next;
                      });
                    }}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        active ? 'border-primary bg-primary' : 'border-surface-600'
                      }`}
                    >
                      {active && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" className="h-3 w-3">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{doc.filename}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {keysOpen && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setKeysOpen(false)} />
          <KeyManagerPanel savedKeys={savedKeys} onChanged={() => void refreshKeys()} />
        </>
      )}

      <div className="rounded-2xl border border-surface-600 bg-surface-900/80 shadow-lg shadow-black/20 transition-colors focus-within:border-primary/60">
        <textarea
          className="max-h-40 w-full resize-none bg-transparent px-4 pt-3.5 text-sm leading-relaxed text-ink-primary placeholder:text-ink-muted focus:outline-none"
          placeholder={streaming ? 'Streaming… you can still type your next message' : 'Ask anything…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!streaming) void send();
            }
          }}
          rows={1}
        />

        <div className="flex items-center gap-1 px-2.5 pb-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void attachFile(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-800 hover:text-white"
            title="Attach a PDF"
          >
            {PAPERCLIP}
            Attach
          </button>
          <button
            type="button"
            onClick={() => setScopeOpen((o) => !o)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
              selectedDocIds.size > 0
                ? 'bg-primary-subtle text-white'
                : 'text-ink-secondary hover:bg-surface-800 hover:text-white'
            }`}
            title="Choose which documents to search"
          >
            {BOOK}
            Knowledge Base
            {selectedDocIds.size > 0 && (
              <span className="rounded-full bg-primary/25 px-1.5 text-[10px] text-primary">
                {selectedDocIds.size}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setKeysOpen((o) => !o)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
              (provider === 'openrouter' || provider === 'nvidia') && !keyedProviders.has(provider)
                ? 'bg-warning/10 text-warning hover:bg-warning/20'
                : 'text-ink-secondary hover:bg-surface-800 hover:text-white'
            }`}
            title="Manage API keys"
          >
            {KEY}
            Keys
            {(provider === 'openrouter' || provider === 'nvidia') && !keyedProviders.has(provider) && (
              <span className="rounded-full bg-warning px-1.5 text-[10px] font-semibold text-black">!</span>
            )}
          </button>

          <span className="flex-1" />

          {streaming ? (
            <button
              type="button"
              onClick={stopStreaming}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-surface-800 hover:text-red-200"
            >
              {SQUARE}
              Stop generating
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void send()}
              disabled={!input.trim()}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-white transition-colors hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed"
              title="Send"
            >
              {ARROW_UP}
            </button>
          )}
        </div>

        {providers.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-surface-600/50 px-3 py-2 text-[11px] text-ink-muted">
            <span className="font-medium text-ink-secondary">Model:</span>
            <select
              className="rounded border border-surface-600 bg-surface-800 px-1.5 py-0.5 text-[11px] text-ink-secondary"
              value={provider}
              onChange={(e) => {
                const next = e.target.value;
                setProvider(next);
                setModel(providers.find((p) => p.id === next)?.models[0] ?? '');
              }}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <select
              className="rounded border border-surface-600 bg-surface-800 px-1.5 py-0.5 text-[11px] text-ink-secondary"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {(providers.find((p) => p.id === provider)?.models ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {(provider === 'openrouter' || provider === 'nvidia') && !keyedProviders.has(provider) && (
        <ComposerKeyBar
          provider={provider}
          providerLabel={providers.find((p) => p.id === provider)?.label ?? provider}
          onSaved={() => void refreshKeys()}
        />
      )}
    </div>
  );

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Unified sidebar: brand, nav, recent chats, user ─────────────────── */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-surface-700/80 bg-surface-950">
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
          <Link href="/" className="flex items-center gap-2.5 text-sm font-semibold text-white">
            <BrandIcon size={28} className="rounded-lg" />
            Smoke Monkey
          </Link>
        </div>

        <div className="px-2">
          <button className="btn-primary w-full justify-start" onClick={newChat} disabled={streaming}>
            <span className="text-base leading-none">+</span> New chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <SidebarNav onNavigate={() => setMenuOpen(false)} />

          <p className="px-5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            Recent Chats
          </p>
          <div className="space-y-0.5 px-2 pb-2">
            {conversations.map((c) => {
              const active = c.id === activeId;
              return (
                <div
                  key={c.id}
                  className={`group relative rounded-lg transition-colors ${
                    active ? 'bg-primary-subtle' : 'hover:bg-surface-800'
                  }`}
                >
                  <button
                    onClick={() => openConversation(c.id)}
                    className={`w-full truncate px-3 py-2 pr-8 text-left text-[13px] ${
                      active ? 'text-white' : 'text-ink-secondary group-hover:text-white'
                    }`}
                    disabled={streaming}
                    title={c.title}
                  >
                    {c.title}
                  </button>
                  <button
                    onClick={() => deleteConversation(c.id)}
                    disabled={streaming}
                    title="Delete conversation"
                    className="absolute right-1 top-1.5 hidden h-5 w-5 items-center justify-center rounded text-ink-muted hover:bg-surface-700 hover:text-red-400 group-hover:flex"
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {conversations.length === 0 && (
              <p className="px-3 py-2 text-xs text-ink-muted">No conversations yet</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-surface-700/80 px-3 py-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-semibold text-primary">
            {userName.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-primary">
            {user.name || user.email}
          </span>
          <button
            title="Sign out"
            className="flex h-6 w-6 items-center justify-center rounded text-ink-muted transition-colors hover:bg-surface-800 hover:text-red-300"
            onClick={() => {
              logout();
              router.push('/login');
            }}
          >
            <svg {...ICON_PROPS}>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </aside>

      {/* ── Chat workspace ─────────────────────────────────────────────────── */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Header — active conversation only */}
        {!isFresh && (
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-surface-700/70 px-6 py-4">
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-white">Chat</h1>
              <p className="text-xs text-ink-muted">Ask anything, get intelligent answers.</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-surface-600/70 bg-surface-800/60 px-2.5 py-1 text-[11px] font-medium text-ink-secondary">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                Hybrid Search
              </span>

              {sourceCount > 0 || webSourceCount > 0 ? (
                <button
                  onClick={toggleSources}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    drawerOpen
                      ? 'border-primary/50 bg-primary-subtle text-white'
                      : 'border-surface-600/70 bg-surface-800/60 text-ink-secondary hover:border-primary/40 hover:text-white'
                  }`}
                >
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/20 text-[9px] text-primary">
                    {sourceCount + webSourceCount}
                  </span>
                  {webSourceCount > 0 && sourceCount > 0 ? 'Sources' : webSourceCount > 0 ? 'Web' : 'Sources'}
                </button>
              ) : null}

              <div className="relative">
                <button
                  onClick={() => setMenuOpen((o) => !o)}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface-800 hover:text-white"
                  title="Menu"
                >
                  {MORE}
                </button>
                {menuOpen && (
                  <>
                    <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
                    <div className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-lg border border-surface-600 bg-surface-900 py-1 shadow-xl">
                      <button
                        className="block w-full px-3 py-2 text-left text-sm text-ink-secondary transition-colors hover:bg-surface-800 hover:text-white"
                        onClick={() => {
                          setMenuOpen(false);
                          newChat();
                        }}
                      >
                        New chat
                      </button>
                      <button
                        className="block w-full px-3 py-2 text-left text-sm text-ink-secondary transition-colors hover:bg-surface-800 hover:text-red-300"
                        onClick={() => {
                          setMenuOpen(false);
                          logout();
                          router.push('/login');
                        }}
                      >
                        Sign out
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </header>
        )}

        {isFresh ? (
          /* ── Fresh chat: centered welcome + composer + prompts ───────────── */
          <div className="flex flex-1 flex-col items-center justify-center gap-7 overflow-y-auto px-6 pb-12 pt-10">
            <div className="text-center fade-in">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15">
                <BrandIcon size={36} />
              </div>
              <h2 className="text-2xl font-semibold text-white">Smoke Monkey AI</h2>
              <p className="mt-1.5 text-sm text-ink-muted">How can I help you today?</p>
            </div>

            {composerCard}

            <div className="flex flex-wrap items-center justify-center gap-2">
              {SUGGESTED_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => void send(p)}
                  disabled={streaming}
                  className="rounded-full border border-surface-600 bg-surface-800/50 px-3.5 py-1.5 text-xs text-ink-secondary transition-colors hover:border-primary/40 hover:text-white disabled:opacity-50"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* ── Active conversation ─────────────────────────────────────────── */
          <>
            <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-6 py-6">
              <div className="mx-auto max-w-3xl space-y-6">
                {messages.map((m) =>
                  m.id === STREAM_ID && streaming ? (
                    <AssistantLoadingCard key={m.id} content={m.content} stages={stages} />
                  ) : (
                    <MessageBubble key={m.id} message={m} onOpenSources={openSources} />
                  ),
                )}
              </div>
            </div>

            {error && (
              <div className="border-t border-error/30 bg-error/10 px-6 py-2 text-sm text-red-300">
                {error}
              </div>
            )}

            <div className="shrink-0 px-6 pb-5 pt-3 fade-in">
              {notice && <p className="mx-auto mb-2 max-w-3xl text-xs text-accent">{notice}</p>}
              {composerCard}
            </div>
          </>
        )}

        {/* ── Sources drawer (foldable overlay) ─────────────────────────────── */}
        <div
          className={`absolute inset-y-0 right-0 z-40 flex w-80 flex-col border-l border-surface-600 bg-surface-900/95 shadow-2xl backdrop-blur transition-transform duration-300 ease-out ${
            drawerOpen ? 'translate-x-0' : 'pointer-events-none translate-x-full'
          }`}
        >
          <div className="flex items-center justify-between border-b border-surface-700/80 px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold text-white">
                Sources
                <span className="ml-2 text-xs font-normal text-ink-muted">
                  {drawerCitations.filter((c) => c.text).length + drawerWebSources.length} items
                </span>
              </h3>
            </div>
            <button
              onClick={() => setDrawerOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface-800 hover:text-white"
              title="Close sources"
            >
              <svg {...ICON_PROPS}>
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {drawerWebSources.length > 0 && (
              <div className="mb-4">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  Web sources
                </p>
                <ul className="space-y-2.5">
                  {drawerWebSources.slice(0, 8).map((s, i) => (
                    <li key={s.url || i} className="rounded-lg border border-surface-700 bg-surface-800/60 p-3">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-surface-700 text-[10px] text-ink-muted">
                          {i + 1}
                        </span>
                        {s.url ? (
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noreferrer"
                            className="min-w-0 flex-1 truncate text-xs font-medium text-primary hover:underline"
                            title={s.url}
                          >
                            {s.title || s.url}
                          </a>
                        ) : (
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-primary" title={s.content}>
                            {s.title || 'Web result'}
                          </span>
                        )}
                        <span className="shrink-0 rounded bg-surface-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
                          {s.provider}
                        </span>
                      </div>
                      {s.content && (
                        <p className="line-clamp-3 text-xs leading-relaxed text-ink-secondary">{s.content}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {drawerCitations.length > 0 ? (
              <ul className="space-y-2.5">
                {drawerCitations
                  .filter((c) => c.text && c.text.trim().length > 0)
                  .slice(0, 8)
                  .map((c, i) => (
                    <li key={i} className="rounded-lg border border-surface-700 bg-surface-800/60 p-3">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-surface-700 text-[10px] text-ink-muted">
                          {i + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-primary" title={c.documentName}>
                          {c.documentName}
                        </span>
                        <SourceScore score={c.score} />
                      </div>
                      {c.page && <p className="mb-1 text-[11px] text-accent">p.{c.page}</p>}
                      <p className="line-clamp-3 text-xs leading-relaxed text-ink-secondary">{c.text}</p>
                    </li>
                  ))}
              </ul>
            ) : (
              drawerWebSources.length === 0 && (
                <div className="flex h-full items-center justify-center px-2 text-center">
                  <p className="text-xs text-ink-muted">No sources for this answer.</p>
                </div>
              )
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
