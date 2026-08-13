'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ModelPreset, ModelsResponseDto, SaveKeyResultDto, UserKeyDto } from '@rag/contracts';
import { api } from '../../lib/api';
import { useAuth } from '../../components/AuthProvider';
import { PageScroll } from '../../components/PageScroll';

interface ProviderMeta {
  id: string;
  label: string;
  hint: string;
  placeholder: string;
  keyStart: string;
  getKeyUrl: string;
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'Cloud gateway with DeepSeek, GLM and NVIDIA models. Get a key at openrouter.ai/keys',
    placeholder: 'sk-or-v1-…',
    keyStart: 'sk-or-v1-',
    getKeyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    hint: 'NVIDIA Nemotron models (chat, embedding, rerank). Get a key at build.nvidia.com',
    placeholder: 'nvapi-…',
    keyStart: 'nvapi-',
    getKeyUrl: 'https://build.nvidia.com',
  },
];

/**
 * Web-search providers the user can bring their own key for. These are NOT
 * live-validated when saved — every probe burns a paid search credit — so the
 * key cards render with `verifies={false}`. Google needs a server-configured
 * Search Engine ID (GOOGLE_SEARCH_CX) so it is not offered here; DuckDuckGo is
 * free and needs no key at all.
 */
const SEARCH_PROVIDERS: ProviderMeta[] = [
  {
    id: 'tavily',
    label: 'Tavily',
    hint: 'Purpose-built search API for AI apps. Get a key at app.tavily.com',
    placeholder: 'tvly-…',
    keyStart: 'tvly-',
    getKeyUrl: 'https://app.tavily.com',
  },
  {
    id: 'brave',
    label: 'Brave Search',
    hint: 'Independent index with a free tier. Get a key at brave.com/search/api/',
    placeholder: 'BSA…',
    keyStart: 'BSA',
    getKeyUrl: 'https://brave.com/search/api/',
  },
  {
    id: 'bing',
    label: 'Bing Web Search',
    hint: 'Microsoft Azure search. Get a key at portal.azure.com',
    placeholder: '32-character key',
    keyStart: '',
    getKeyUrl: 'https://portal.azure.com',
  },
];

function WebSearchToggle() {
  const [webSearch, setWebSearch] = useState<{ serverEnabled: boolean; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    api
      .fetchSettings()
      .then((s) => setWebSearch(s.webSearch))
      .catch(() => setWebSearch({ serverEnabled: false, enabled: false }));
  }, []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.setWebSearchEnabled(enabled);
      setWebSearch(res.webSearch);
      setMsg({ kind: 'ok', text: enabled ? 'Web search is on.' : 'Web search is off.' });
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const serverEnabled = webSearch?.serverEnabled ?? false;
  const enabled = webSearch?.enabled ?? false;

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white">Live web search</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Adds fresh, current information from the web when a question needs it.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-disabled={!serverEnabled || busy}
          disabled={!serverEnabled || busy}
          onClick={() => void toggle(!enabled)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
            enabled ? 'bg-primary' : 'bg-surface-600'
          } ${!serverEnabled ? 'cursor-not-allowed opacity-50' : ''}`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
              enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {!serverEnabled ? (
        <p className="text-xs text-amber-300">
          Web search is disabled by the server administrator. Ask them to set{' '}
          <code className="rounded bg-surface-800 px-1 py-0.5 text-[11px] text-slate-300">
            WEB_SEARCH_ENABLED=true
          </code>{' '}
          in the environment.
        </p>
      ) : (
        <p className={`text-xs ${enabled ? 'text-emerald-300' : 'text-slate-500'}`}>
          {enabled
            ? 'On — questions that need current info also check the web.'
            : 'Off — answers come from your documents and model knowledge only.'}
        </p>
      )}

      {msg && (
        <p className={`text-sm ${msg.kind === 'ok' ? 'text-emerald-300' : 'text-red-400'}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

function KeyCard({ meta, verifies = true }: { meta: ProviderMeta; verifies?: boolean }) {
  const [saved, setSaved] = useState<UserKeyDto | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [testInfo, setTestInfo] = useState<SaveKeyResultDto['info'] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { keys } = await api.listKeys();
      setSaved(keys.find((k) => k.provider === meta.id) ?? null);
    } catch {
      setSaved(null);
    }
  }, [meta.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.saveKey(meta.id, value.trim());
      setValue('');
      setTestInfo(res.info);
      setMsg({ kind: 'ok', text: verifies ? 'Key saved and verified.' : 'Key saved.' });
      await refresh();
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.testKey(meta.id);
      setTestInfo(res.info);
      setMsg({ kind: 'ok', text: verifies ? 'Key is valid.' : 'Format looks valid (live check skipped to save quota).' });
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.deleteKey(meta.id);
      setSaved(null);
      setTestInfo(null);
      setMsg({ kind: 'ok', text: 'Key removed.' });
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white">{meta.label}</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {meta.hint}{' '}
            <a className="text-accent hover:underline" href={meta.getKeyUrl} target="_blank" rel="noreferrer">
              Get one →
            </a>
          </p>
        </div>
        {saved && (
          <span className="rounded-full bg-emerald-900/50 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
            {saved.keyPrefix}…{saved.last4}
          </span>
        )}
      </div>

      {testInfo && (
        <div className="rounded-lg border border-surface-600 bg-surface-800 px-3 py-2 text-xs text-slate-300">
          <span className="font-medium text-slate-200">{testInfo.label || meta.label}</span>
          {testInfo.isFreeTier && <span> · free tier</span>}
          {testInfo.remaining != null && (
            <span> · ${testInfo.remaining.toFixed(2)} remaining</span>
          )}
          {testInfo.rateLimited && <span className="text-amber-300"> · rate limited</span>}
        </div>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          className="input font-mono"
          type="password"
          placeholder={saved ? 'Replace existing key…' : meta.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
        />
        <button className="btn-primary shrink-0" disabled={busy || !value.trim()}>
          Save
        </button>
      </form>

      {saved && (
        <div className="flex gap-2">
          <button className="btn-ghost flex-1" onClick={test} disabled={busy}>
            Test key
          </button>
          <button
            className="btn-ghost flex-1 border-red-900 text-red-300 hover:bg-red-950/40"
            onClick={remove}
            disabled={busy}
          >
            Remove
          </button>
        </div>
      )}

      {msg && (
        <p className={`text-sm ${msg.kind === 'ok' ? 'text-emerald-300' : 'text-red-400'}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

function Stars({ rating }: { rating: number }) {
  return <span className="text-amber-300">{'★'.repeat(rating)}<span className="text-slate-700">{'★'.repeat(5 - rating)}</span></span>;
}

export default function SettingsPage() {
  const { user } = useAuth();
  const [models, setModels] = useState<ModelsResponseDto | null>(null);

  useEffect(() => {
    api.fetchModels().then(setModels).catch(() => setModels(null));
  }, []);

  const presets: ModelPreset[] = models?.presets ?? [];
  const chatPresets = presets.filter((p) => ['main', 'reasoning', 'coding', 'flagship', 'efficient', 'fast', 'vision'].includes(p.role));
  const retrievalPresets = presets.filter((p) => ['embed', 'embed-multi', 'rerank'].includes(p.role));

  return (
    <PageScroll>
      <div className="mx-auto w-full max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white">Settings</h1>
        <p className="text-sm text-slate-500">
          Signed in as {user?.email}. Provider keys are encrypted on the server and only used by you.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Provider API keys
        </h2>
        <p className="text-xs text-slate-500">
          When you save your own key it is always used for your requests (chat, embeddings and
          reranking) — server defaults are only a fallback.
        </p>
        {PROVIDERS.map((meta) => (
          <KeyCard key={meta.id} meta={meta} />
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Web search
        </h2>
        <WebSearchToggle />
        <p className="text-xs text-slate-500">
          Search providers are queried together when web search is on — every provider with
          a key below contributes results. Google needs a server-configured Search Engine ID,
          and DuckDuckGo is free (no key needed) as the automatic fallback.
        </p>
        {SEARCH_PROVIDERS.map((meta) => (
          <KeyCard key={meta.id} meta={meta} verifies={false} />
        ))}
      </section>

      {models && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Active RAG layers
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="card text-sm">
              <p className="text-xs uppercase tracking-wide text-slate-500">Embedding</p>
              <p className="mt-1 truncate font-mono text-xs text-slate-200">
                {models.embedding.provider}: {models.embedding.model}
              </p>
              <p className="text-xs text-slate-500">{models.embedding.dims} dims · fixed by the pgvector index</p>
            </div>
            <div className="card text-sm">
              <p className="text-xs uppercase tracking-wide text-slate-500">Rerank</p>
              <p className="mt-1 truncate font-mono text-xs text-slate-200">
                {models.rerank.enabled ? `${models.rerank.provider}: ${models.rerank.model}` : 'disabled'}
              </p>
              <p className="text-xs text-slate-500">Re-scores retrieval results before the LLM</p>
            </div>
          </div>
        </section>
      )}

      {chatPresets.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
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
                </tr>
              </thead>
              <tbody>
                {chatPresets.map((p) => (
                  <tr key={p.role} className="border-b border-surface-800 last:border-0">
                    <td className="px-4 py-2.5 text-slate-200">
                      {p.label}
                      <span className="mt-0.5 block text-xs text-slate-500">{p.notes}</span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-300">{p.model}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-400">{p.providerLabel}</td>
                    <td className="px-4 py-2.5 text-xs">
                      <Stars rating={p.rating} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {retrievalPresets.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
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
                </tr>
              </thead>
              <tbody>
                {retrievalPresets.map((p) => (
                  <tr key={p.role} className="border-b border-surface-800 last:border-0">
                    <td className="px-4 py-2.5 text-slate-200">
                      {p.label}
                      <span className="mt-0.5 block text-xs text-slate-500">{p.notes}</span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-300">{p.model}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-400">{p.providerLabel}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-400">{p.dims ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
    </PageScroll>
  );
}
