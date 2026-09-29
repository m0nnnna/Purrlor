import { useEffect, useState } from 'react';
import './CodeBlock.css';

type Highlighted = { html: string; language: string } | null;

// Prism (and its ~15 language grammars, see codeHighlight.ts) is only worth its weight once a
// message actually has a fenced code block to show — dynamically imported and cached so every
// CodeBlock on the page shares one load instead of importing it once per block.
let highlighterPromise: Promise<typeof import('./codeHighlight')> | null = null;
function loadHighlighter() {
  if (!highlighterPromise) highlighterPromise = import('./codeHighlight');
  return highlighterPromise;
}

/** A ```-fenced block from a message — see renderMessageText.tsx. Renders plain (but still
 *  monospaced) — the same as an unrecognized language tag — until Prism has loaded, then
 *  re-renders highlighted. */
export function CodeBlock({ code, language }: { code: string; language: string }) {
  const [highlighted, setHighlighted] = useState<Highlighted>(null);

  useEffect(() => {
    if (!language) return;
    let cancelled = false;
    loadHighlighter().then(({ highlightCode }) => {
      if (!cancelled) setHighlighted(highlightCode(code, language));
    });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  if (!highlighted) {
    return (
      <pre className="nu-code-block" data-nu-role="code-block">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <pre className="nu-code-block" data-nu-role="code-block">
      <code
        className={`language-${highlighted.language}`}
        // Prism.highlight escapes text it wraps in token spans itself — this is the same
        // trusted-library pattern any Prism-based renderer uses, not raw user HTML.
        dangerouslySetInnerHTML={{ __html: highlighted.html }}
      />
    </pre>
  );
}
