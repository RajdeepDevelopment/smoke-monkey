import type {
  AuthResponseDto,
  ConversationDto,
  DocumentDto,
  MessageDto,
  MetricsSummaryDto,
  ModelsResponseDto,
  RetrieveResponseDto,
  UserKeyDto,
  UserKeysResponseDto,
  UserSettingsDto,
  SaveKeyResultDto,
} from '@rag/contracts';
import { streamSse } from './sse';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

const TOKEN_KEY = 'rag_token';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new ApiError(body.message || res.statusText, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // auth
  register: (email: string, name: string, password: string) =>
    request<AuthResponseDto>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, name, password }),
    }),
  login: (email: string, password: string) =>
    request<AuthResponseDto>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () =>
    request<{ status: string }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<{ user: { id: string; email: string } }>('/api/auth/me', { method: 'POST' }),

  // documents
  uploadDocument: async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${API_URL}/api/documents/upload`, {
      method: 'POST',
      body: form,
      headers,
      credentials: 'include',
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new ApiError(body.message || res.statusText, res.status);
    }
    return res.json() as Promise<DocumentDto>;
  },
  listDocuments: () => request<DocumentDto[]>('/api/documents'),
  deleteDocument: (id: string) =>
    request<{ status: string }>(`/api/documents/${id}`, { method: 'DELETE' }),

  // conversations
  listConversations: () => request<ConversationDto[]>('/api/conversations'),
  createConversation: (title?: string) =>
    request<ConversationDto>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  getMessages: (conversationId: string) =>
    request<MessageDto[]>(`/api/conversations/${conversationId}/messages`),
  deleteConversation: (id: string) =>
    request<{ status: string }>(`/api/conversations/${id}`, { method: 'DELETE' }),

  // chat (SSE)
  streamChat: async function* (
    message: string,
    conversationId: string | undefined,
    signal: AbortSignal,
    provider?: string,
    model?: string,
    documentIds?: string[],
  ) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${API_URL}/api/chat/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, conversationId, provider, model, documentIds }),
      signal,
      credentials: 'include',
    });
    yield* streamSse(res, signal);
  },

  // models
  fetchModels: () => request<ModelsResponseDto>('/api/models'),

  // playground (retrieval only, no generation)
  playgroundRetrieve: (payload: {
    message: string;
    mode?: string;
    provider?: string;
    model?: string;
    documentIds?: string[];
  }) =>
    request<RetrieveResponseDto>('/api/playground/retrieve', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // analytics (Redis telemetry summary)
  analyticsMetrics: () => request<MetricsSummaryDto>('/api/analytics/metrics'),

  // system health (public)
  health: () =>
    fetch(`${API_URL}/api/health`, { credentials: 'include' }).then((res) =>
      res.json().catch(() => ({ status: 'unknown' })) as Promise<{
        status: string;
        postgres?: boolean;
        redis?: boolean;
        nats?: boolean;
      }>,
    ),

  // provider API keys (OpenRouter, NVIDIA, ...) — per user, encrypted on server
  listKeys: () => request<UserKeysResponseDto>('/api/keys'),
  saveKey: (provider: string, apiKey: string) =>
    request<SaveKeyResultDto>(`/api/keys/${provider}`, {
      method: 'PUT',
      body: JSON.stringify({ apiKey }),
    }),
  deleteKey: (provider: string) =>
    request<{ status: string }>(`/api/keys/${provider}`, { method: 'DELETE' }),
  testKey: (provider: string) =>
    request<{ status: string; info: SaveKeyResultDto['info'] }>(`/api/keys/${provider}/test`, {
      method: 'POST',
    }),

  // user feature settings (web search opt-in)
  fetchSettings: () => request<UserSettingsDto>('/api/settings'),
  setWebSearchEnabled: (enabled: boolean) =>
    request<Pick<UserSettingsDto, 'webSearch'>>('/api/settings/web-search', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
};
