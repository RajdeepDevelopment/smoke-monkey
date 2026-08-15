import { Injectable, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiKeysService } from '../keys/api-keys.service';
import { CitationJson, WebSourceJson } from '../conversations/message.entity';
import { ConversationsService } from '../conversations/conversations.service';
import { ChatDto } from './dto/chat.dto';

interface UpstreamEvent {
  type: string;
  [key: string]: unknown;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly ragUrl = process.env.RAG_SERVICE_URL || 'http://localhost:8000';

  constructor(
    private readonly conversations: ConversationsService,
    private readonly keys: ApiKeysService,
  ) {}

  async streamChat(
    userId: string,
    dto: ChatDto,
    res: Response,
    req: Request,
  ): Promise<void> {
    const conversation = dto.conversationId
      ? await this.conversations.getOwned(userId, dto.conversationId)
      : await this.conversations.create(userId, dto.message.slice(0, 60));

    await this.conversations.addMessage(conversation.id, 'user', dto.message);

    const historyMessages = await this.conversations.getHistory(conversation.id, 12);
    const history = historyMessages
      .slice(0, -1) // drop the message we just saved
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

    const write = (event: UpstreamEvent): void => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    write({ type: 'meta', conversationId: conversation.id });

    // Resolve the API key for cloud providers: the user's own key wins,
    // otherwise fall back to the server default. Keys are read from Redis
    // (populated on save) so lookups stay fast and don't hit Postgres.
    const CLOUD_PROVIDERS = ['openrouter', 'nvidia', 'openai', 'xai', 'gemini'];
    const isCloud = CLOUD_PROVIDERS.includes(dto.provider);
    let apiKey: string | null = null;
    if (isCloud) {
      try {
        apiKey = (await this.keys.getKey(userId, dto.provider)) || null;
      } catch (err) {
        this.logger.warn(`failed to resolve user key for ${userId}: ${err}`);
        apiKey = null;
      }
      const serverEnv =
        dto.provider === 'nvidia'
          ? process.env.NVIDIA_API_KEY
          : dto.provider === 'openai'
            ? process.env.OPENAI_API_KEY
            : dto.provider === 'xai'
              ? process.env.XAI_API_KEY
              : dto.provider === 'gemini'
                ? process.env.GEMINI_API_KEY
                : process.env.OPENROUTER_API_KEY;
      if (!apiKey && !serverEnv) {
        const noKeyMsg =
          dto.provider === 'nvidia'
            ? 'No NVIDIA key configured. Add one in Settings (recommended) or ask the administrator to set NVIDIA_API_KEY.'
            : dto.provider === 'openai'
              ? 'No OpenAI key configured. Add one in Settings → API keys (recommended) or ask the administrator to set OPENAI_API_KEY.'
              : dto.provider === 'xai'
                ? 'No xAI key configured. Add one in Settings → API keys (recommended) or ask the administrator to set XAI_API_KEY.'
                : dto.provider === 'gemini'
                  ? 'No Gemini key configured. Add one free in Settings → API keys (aistudio.google.com/apikey) or ask the administrator to set GEMINI_API_KEY.'
                  : 'No OpenRouter key configured. Add one in Settings (recommended) or ask the administrator to set OPENROUTER_API_KEY.';
        write({ type: 'error', message: noKeyMsg });
        res.end();
        return;
      }
    }

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    let assistantContent = '';
    let citations: CitationJson[] | null = null;
    let webSources: WebSourceJson[] | null = null;
    let confidence = 0;
    let timings: Record<string, number> | null = null;

    try {
      const upstream = await fetch(`${this.ragUrl}/api/v1/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: dto.message,
          conversation_id: conversation.id,
          user_id: userId,
          history,
          provider: dto.provider,
          model: dto.model,
          mode: dto.mode,
          document_ids: dto.documentIds ?? [],
          api_key: apiKey,
        }),
        signal: controller.signal,
      });

      if (!upstream.ok || !upstream.body) {
        const detail = (await upstream.text().catch(() => '')).slice(0, 300);
        throw new Error(
          `query service responded with ${upstream.status}${detail ? `: ${detail}` : ''}`,
        );
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = this.parseSseBlock(raw);
          if (!event) continue;
          switch (event.type) {
            case 'chunk':
              assistantContent += event.text as string;
              write({ type: 'chunk', text: event.text });
              break;
            case 'status':
              write({ type: 'status', stage: event.stage, label: event.label });
              break;
            case 'sources':
              citations = event.citations as CitationJson[];
              write({ type: 'sources', citations: event.citations });
              break;
            case 'web_sources':
              webSources = (event.sources ?? []) as WebSourceJson[];
              write({ type: 'web_sources', sources: event.sources ?? [] });
              break;
            case 'done':
              citations = (event.citations as CitationJson[]) ?? citations;
              confidence = Number(event.confidence ?? 0);
              timings = (event.timings as Record<string, number>) ?? timings;
              break;
            case 'error':
              write({ type: 'error', message: event.message });
              break;
            case 'timings':
              timings = event.timings as Record<string, number>;
              write({ type: 'timings', timings: event.timings });
              this.logger.debug(
                `query timings total=${timings.total_ms}ms ` +
                  `embed=${timings.embedding_ms} retr=${timings.retrieval_ms} ` +
                  `rerank=${timings.reranker_ms} ttft=${timings.llm_ttft_ms} ` +
                  `gen=${timings.llm_generation_ms}`,
              );
              break;
            default:
              break;
          }
        }
      }
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      if (aborted) {
        this.logger.warn('stream aborted by client');
      } else {
        this.logger.error(`rag-service call failed: ${(err as Error).message}`);
        write({
          type: 'error',
          message: (err as Error).message || 'query service unavailable',
        });
      }
    }

    if (assistantContent) {
      const saved = await this.conversations.addMessage(
        conversation.id,
        'assistant',
        assistantContent,
        citations ?? null,
        confidence,
        webSources,
      );
      write({
        type: 'done',
        messageId: saved.id,
        citations: citations ?? [],
        confidence,
        timings: timings ?? undefined,
      });
    }
    res.end();
  }

  private parseSseBlock(raw: string): UpstreamEvent | null {
    const lines = raw.split('\n');
    let type = 'message';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return null;
    try {
      return { type, ...JSON.parse(data) };
    } catch {
      return null;
    }
  }
}
