'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowUp,
  Book,
  Check,
  ExternalLink,
  Key,
  Loader2,
  Paperclip,
  Search,
  Square,
} from 'lucide-react';
import type { DocumentDto, ModelPreset, ModelProvider, UserKeyDto } from '@rag/contracts';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { ResponsivePopover } from '../ui/responsive-popover';
import { ModelPicker } from './ModelPicker';

interface ChatComposerProps {
  input: string;
  onInputChange: (value: string) => void;
  streaming: boolean;
  onSend: () => void;
  onStop: () => void;
  disabled?: boolean;
  documents: DocumentDto[];
  selectedDocIds: Set<string>;
  onToggleDoc: (id: string) => void;
  onClearScope: () => void;
  savedKeys: UserKeyDto[];
  onKeysChanged: () => void;
  providers: ModelProvider[];
  provider: string;
  model: string;
  defaultProvider?: string;
  presets?: ModelPreset[];
  onModelChange: (provider: string, model: string) => void;
  onAttach: (file: File) => void;
  placeholder?: string;
}

const KEY_PROVIDERS = [
  { id: 'openrouter', label: 'OpenRouter', group: 'Chat models', placeholder: 'sk-or-v1-…', getKeyUrl: 'https://openrouter.ai/keys' },
  { id: 'nvidia', label: 'NVIDIA NIM', group: 'Chat models', placeholder: 'nvapi-…', getKeyUrl: 'https://build.nvidia.com' },
  { id: 'tavily', label: 'Tavily', group: 'Web search', placeholder: 'tvly-…', getKeyUrl: 'https://app.tavily.com' },
  { id: 'brave', label: 'Brave Search', group: 'Web search', placeholder: 'BSA…', getKeyUrl: 'https://brave.com/search/api/' },
  { id: 'bing', label: 'Bing Web Search', group: 'Web search', placeholder: '32-character key', getKeyUrl: 'https://portal.azure.com' },
];

/** Provider whose chat requests need a saved user key. */
const CHAT_KEY_PROVIDERS = new Set(['openrouter', 'nvidia']);

function ScopePicker({
  documents,
  selectedDocIds,
  onToggleDoc,
  onClearScope,
}: {
  documents: DocumentDto[];
  selectedDocIds: Set<string>;
  onToggleDoc: (id: string) => void;
  onClearScope: () => void;
}) {
  const all = selectedDocIds.size === 0;
  return (
    <div className="w-full sm:w-80">
      <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        Knowledge Base
      </p>
      <p className="px-1 pb-2 text-[11px] text-ink-muted">
        Search the selected documents. Nothing selected = all documents.
      </p>
      <button
        type="button"
        onClick={onClearScope}
        className={cn(
          'mb-1 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
          all ? 'bg-primary-subtle text-white' : 'text-ink-secondary hover:bg-surface-800',
        )}
      >
        <span
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
            all ? 'border-primary bg-primary' : 'border-surface-600',
          )}
        >
          {all && <Check className="h-3 w-3 text-white" />}
        </span>
        All documents
      </button>
      <div className="max-h-56 space-y-0.5 overflow-y-auto scrollbar-thin">
        {documents.length === 0 && (
          <p className="px-2.5 py-2 text-xs text-ink-muted">
            No documents ready yet.{' '}
            <Link href="/documents" className="text-primary hover:underline">
              Upload one
            </Link>
          </p>
        )}
        {documents.map((doc) => {
          const active = selectedDocIds.has(doc.id);
          return (
            <button
              key={doc.id}
              type="button"
              onClick={() => onToggleDoc(doc.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                active ? 'bg-primary-subtle text-white' : 'text-ink-secondary hover:bg-surface-800',
              )}
            >
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                  active ? 'border-primary bg-primary' : 'border-surface-600',
                )}
              >
                {active && <Check className="h-3 w-3 text-white" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{doc.filename}</span>
            </button>
          );
        })}
      </div>
      {selectedDocIds.size > 0 && (
        <p className="pt-2 text-[11px] text-ink-muted">
          {selectedDocIds.size} document{selectedDocIds.size > 1 ? 's' : ''} selected
        </p>
      )}
    </div>
  );
}

function KeyManager({
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

  return (
    <div className="w-full sm:w-80">
      <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        API keys
      </p>
      <p className="px-1 pb-2 text-[11px] text-ink-muted">
        Add your own keys here — they are used for your chat and web search requests.
      </p>
      <div className="max-h-64 space-y-3 overflow-y-auto pr-0.5 scrollbar-thin">
        {(['Chat models', 'Web search'] as const).map((group) => (
          <div key={group}>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">{group}</p>
            <div className="space-y-2">
              {KEY_PROVIDERS.filter((p) => p.group === group).map((p) => {
                const saved = savedFor(p.id);
                return (
                  <div key={p.id} className="rounded-lg border border-surface-700 bg-surface-800/60 p-2">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-ink-primary">{p.label}</span>
                      {saved ? (
                        <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] text-success">
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
                        {busyId === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
                      </button>
                      <a
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-surface-600 text-ink-muted transition-colors hover:bg-surface-800 hover:text-white"
                        href={p.getKeyUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={`Get ${p.label} key`}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
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
        <p className={cn('mt-1.5 text-xs', msg.kind === 'ok' ? 'text-success' : 'text-red-400')}>{msg.text}</p>
      )}
    </div>
  );
}

/**
 * The chat composer: auto-growing textarea, attach / knowledge scope / keys
 * actions, model picker, and send/stop. Everything is touch-friendly and
 * keyboard-first (Enter sends, Shift+Enter is a newline).
 */
export function ChatComposer({
  input,
  onInputChange,
  streaming,
  onSend,
  onStop,
  disabled,
  documents,
  selectedDocIds,
  onToggleDoc,
  onClearScope,
  savedKeys,
  onKeysChanged,
  providers,
  provider,
  model,
  defaultProvider,
  presets,
  onModelChange,
  onAttach,
  placeholder,
}: ChatComposerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const needsKey = CHAT_KEY_PROVIDERS.has(provider) && !savedKeys.some((k) => k.provider === provider);

  return (
    <div className="rounded-2xl border border-surface-700 bg-surface-900/80 shadow-lg shadow-black/20 backdrop-blur transition-all focus-within:border-primary/50">
      <textarea
        rows={1}
        value={input}
        placeholder={placeholder ?? 'Ask anything…'}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!streaming && input.trim() && !disabled) onSend();
          }
        }}
        className="max-h-40 w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-sm leading-relaxed text-ink-primary placeholder:text-ink-muted focus:outline-none"
      />

      <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2 pt-0.5">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onAttach(file);
            e.target.value = '';
          }}
        />
        <ComposerAction
          icon={<Paperclip className="h-4 w-4" />}
          label="Attach"
          onClick={() => fileInputRef.current?.click()}
          title="Attach a PDF"
        />

        <ResponsivePopover
          sheetTitle="Knowledge Base"
          className="p-3"
          trigger={
            <button
              type="button"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
                selectedDocIds.size > 0
                  ? 'bg-primary-subtle text-white'
                  : 'text-ink-secondary hover:bg-surface-800 hover:text-white',
              )}
              title="Choose which documents to search"
            >
              <Book className="h-4 w-4" />
              <span className="hidden sm:inline">Knowledge Base</span>
              {selectedDocIds.size > 0 && (
                <span className="rounded-full bg-primary/25 px-1.5 text-[10px] text-primary">{selectedDocIds.size}</span>
              )}
            </button>
          }
        >
          <ScopePicker
            documents={documents}
            selectedDocIds={selectedDocIds}
            onToggleDoc={onToggleDoc}
            onClearScope={onClearScope}
          />
        </ResponsivePopover>

        <ResponsivePopover
          sheetTitle="API keys"
          className="p-3"
          trigger={
            <button
              type="button"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
                needsKey
                  ? 'bg-warning/10 text-warning hover:bg-warning/20'
                  : 'text-ink-secondary hover:bg-surface-800 hover:text-white',
              )}
              title="Manage API keys"
            >
              <Key className="h-4 w-4" />
              <span className="hidden sm:inline">Keys</span>
              {needsKey && <span className="rounded-full bg-warning px-1.5 text-[10px] font-semibold text-black">!</span>}
            </button>
          }
        >
          <KeyManager savedKeys={savedKeys} onChanged={onKeysChanged} />
        </ResponsivePopover>

        <span className="hidden flex-1 sm:block" />

        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-surface-800 hover:text-red-200"
          >
            <Square className="h-3.5 w-3.5" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || !input.trim()}
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-white shadow-lg shadow-primary/25 transition-all hover:bg-primary-hover active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            title="Send"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>

      {providers.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-surface-700/50 px-3 py-2">
          <span className="text-[11px] font-medium text-ink-muted">Model</span>
          <ModelPicker
            providers={providers}
            provider={provider}
            model={model}
            defaultProvider={defaultProvider}
            presets={presets}
            onChange={onModelChange}
            compact
          />
          {needsKey && (
            <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-warning">
              <Search className="h-3 w-3" />
              Add your {providers.find((p) => p.id === provider)?.label ?? provider} key to chat
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ComposerAction({
  icon,
  label,
  onClick,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-800 hover:text-white"
      title={title}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
