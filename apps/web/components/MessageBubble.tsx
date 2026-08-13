'use client';

import { memo } from 'react';
import type { CitationDto, WebSourceDto } from '@rag/contracts';
import { BrandIcon } from './BrandIcon';
import { Markdown } from './Markdown';

export interface BubbleMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: CitationDto[] | null;
  webSources?: WebSourceDto[] | null;
  confidence?: number | null;
  pending?: boolean;
}

interface MessageBubbleProps {
  message: BubbleMessage;
  onOpenSources?: (citations: CitationDto[], webSources: WebSourceDto[]) => void;
}

/**
 * A single chat bubble. Memoized with a shallow compare so token-by-token
 * streaming updates only re-render the bubble whose content changed — every
 * other message in the thread is skipped.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  onOpenSources,
}: MessageBubbleProps) {
  const { role, content, citations, webSources, pending } = message;
  const isUser = role === 'user';
  const sources = (citations ?? [])
    .filter((c) => c.text && c.text.trim().length > 0)
    .slice(0, 8);
  const webCount = (webSources ?? []).filter((s) => s.url || s.content).length;

  return (
    <div className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex max-w-[85%] flex-col items-start gap-1.5 ${isUser ? 'items-end' : ''}`}>
        <div className={`flex w-full items-start gap-2.5 ${isUser ? 'flex-row-reverse' : ''}`}>
          {!isUser && (
            <BrandIcon size={24} className="mt-0.5 rounded-full" />
          )}
          <div
            className={`min-w-0 rounded-xl px-4 py-3 text-sm leading-relaxed ${
              isUser
                ? 'bg-primary text-white'
                : 'border border-surface-600 bg-surface-800 text-ink-primary'
            }`}
          >
            {isUser ? (
              <div className="whitespace-pre-wrap">{content}</div>
            ) : (
              <>
                <Markdown content={content} />
                {pending && <span className="ml-1 animate-pulse text-ink-muted">▍</span>}
              </>
            )}
          </div>
        </div>
        {!isUser && !pending && (sources.length > 0 || webCount > 0) && onOpenSources && (
          <button
            onClick={() => onOpenSources(citations ?? [], webSources ?? [])}
            className="ml-8 inline-flex items-center gap-1.5 rounded-full border border-surface-600 bg-surface-800/60 px-2.5 py-1 text-[11px] font-medium text-ink-secondary transition-colors hover:border-primary/40 hover:text-white"
          >
            <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary/20 text-[9px] text-primary">
              {sources.length + webCount}
            </span>
            {webCount > 0 && sources.length > 0 ? 'Sources' : webCount > 0 ? 'Web sources' : 'Sources'}
          </button>
        )}
      </div>
    </div>
  );
});
