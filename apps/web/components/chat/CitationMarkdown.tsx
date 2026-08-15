'use client';

import { memo } from 'react';
import { Markdown } from '../Markdown';
import { cn } from '../../lib/utils';

interface CitationTextProps {
  children: string;
  onCite: (index: number) => void;
}

/**
 * Splits a text node on "[n]" citation markers and renders each as a small
 * interactive chip. The regex keeps capture groups so we can interleave the
 * plain text and the citations in order.
 */
function CitationText({ children, onCite }: CitationTextProps) {
  const parts = children.split(/(\[\d+\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const match = /^\[(\d+)\]$/.exec(part);
        if (match) {
          const index = Number(match[1]);
          return (
            <button
              key={i}
              type="button"
              onClick={() => onCite(index)}
              className={cn(
                'mx-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded px-1 align-middle text-[10px] font-semibold',
                'bg-primary/15 text-primary-hover transition-colors hover:bg-primary/30 hover:text-white',
              )}
              aria-label={`Open citation ${index}`}
            >
              {index}
            </button>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

interface CitationMarkdownProps {
  content: string;
  onCite: (index: number) => void;
}

/** Markdown where "[n]" markers render as clickable citation chips. */
export const CitationMarkdown = memo(function CitationMarkdown({
  content,
  onCite,
}: CitationMarkdownProps) {
  return (
    <Markdown
      content={content}
      components={{
        // Override text nodes: code spans/blocks are separate nodes so they
        // are not affected by this transform.
        text: ({ children }) => <CitationText onCite={onCite}>{children as string}</CitationText>,
      }}
    />
  );
});
