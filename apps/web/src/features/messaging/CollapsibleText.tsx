import { useState, type ReactNode } from 'react';
import './CollapsibleText.css';

/** Past either of these a message starts folded: about a screenful in a wide window. */
export const COLLAPSE_WORDS = 200;
export const COLLAPSE_LINES = 15;

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Whether a message is long enough to fold. Pure, so it's tested directly. */
export function isLongMessage(text: string): boolean {
  return wordCount(text) > COLLAPSE_WORDS || text.split('\n').length > COLLAPSE_LINES;
}

/**
 * A message body that folds when it's very long, so one wall of text doesn't fill the whole
 * channel: the first several lines show, fading out, with Show more under them. Show more opens it
 * where it is, and Show less folds it again. Short messages render as they always did.
 */
export function CollapsibleText({ text, className, children }: { text: string; className: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  if (!isLongMessage(text)) return <div className={className}>{children}</div>;
  return (
    <>
      <div
        className={expanded ? className : `${className} nu-collapsible--collapsed`}
        data-nu-role="message-collapsible"
        data-nu-collapsed={!expanded}
      >
        {children}
      </div>
      <button
        type="button"
        className="nu-collapsible__toggle"
        data-nu-role="message-collapsible-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        {expanded ? 'Show less' : `Show more (${wordCount(text).toLocaleString()} words)`}
      </button>
    </>
  );
}
