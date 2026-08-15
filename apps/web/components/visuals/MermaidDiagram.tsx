'use client';

import { useEffect, useId, useState } from 'react';
import { AddonShell } from './AddonShell';

interface MermaidDiagramProps {
  code: string;
}

/**
 * Renders a ```mermaid fence body into a live SVG diagram.
 *
 * Mermaid is ESM-only and heavy, so it's imported on demand inside an effect
 * (never on the server). Each instance gets a unique id and renders in a dark
 * theme that matches the app. Any render failure falls back to the raw source
 * so the content is never lost.
 */
export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);

    (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'strict',
          fontFamily: 'inherit',
          themeVariables: {
            darkMode: true,
            background: 'transparent',
            primaryColor: '#7C3AED',
            primaryTextColor: '#F8FAFC',
            primaryBorderColor: '#8B5CF6',
            lineColor: '#334155',
            secondaryColor: '#1a2333',
            tertiaryColor: '#111827',
            clusterBkg: '#111827',
            clusterBorder: '#334155',
            edgeLabelBackground: '#111827',
            nodeTextColor: '#F8FAFC',
          },
        });
        const { svg: rendered } = await mermaid.render(`mmd-${rawId}`, code);
        if (!cancelled) setSvg(rendered);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rawId, code]);

  return (
    <AddonShell type="mermaid" label="Flow diagram">
      {error ? (
        <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-red-300">
          {code}
        </pre>
      ) : svg ? (
        <div
          className="w-full max-w-full overflow-x-auto [&_svg]:mx-auto [&_svg]:block [&_svg]:min-w-[520px] [&_svg]:max-w-none"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="h-16 animate-pulse bg-surface-800/60" aria-label="Rendering diagram…" />
      )}
    </AddonShell>
  );
}
