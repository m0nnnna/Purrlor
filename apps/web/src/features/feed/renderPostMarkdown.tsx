import type { ReactNode } from 'react';
import './renderPostMarkdown.css';

/**
 * A post's Markdown blocks, on top of the inline Markdown renderMessageText.tsx already does
 * (bold, italics, code, spoilers, links, fenced code): `#` headings, `-`/`*`/`+` and `1.` lists,
 * `>` quotes and `---` rules. Like the inline kind, it's read from the plain `body` the author
 * typed, never from HTML, so it looks the same whichever client sent it.
 *
 * Each block's text goes through `renderInline` (renderMessageText, with the post's emotes,
 * mentions and hashtags). A body with no block syntax at all is handed over whole, exactly as
 * before, which keeps a message of only emotes showing them big. Fenced code is never split:
 * its lines stay one paragraph for renderInline's own fence handling. Lists are one level deep.
 */

type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'rule' };

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const QUOTE = /^>\s?(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const RULE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const FENCE_OPEN = /^\s{0,3}```/;
const FENCE_CLOSE = /```\s*$/;

function startsBlock(line: string): boolean {
  return HEADING.test(line) || QUOTE.test(line) || BULLET.test(line) || NUMBERED.test(line) || RULE.test(line);
}

export function parsePostBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }

    if (FENCE_OPEN.test(line)) {
      // Up to and including the closing fence (or to the end, if there isn't one).
      const start = i;
      const closedOnSameLine = line.trim().length > 3 && FENCE_CLOSE.test(line.trim().slice(3));
      i++;
      if (!closedOnSameLine) {
        while (i < lines.length && !FENCE_CLOSE.test(lines[i])) i++;
        i = Math.min(i + 1, lines.length);
      }
      blocks.push({ kind: 'paragraph', text: lines.slice(start, i).join('\n') });
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      for (let quote = QUOTE.exec(lines[i]); quote; quote = i < lines.length ? QUOTE.exec(lines[i]) : null) {
        quoted.push(quote[1]);
        i++;
      }
      blocks.push({ kind: 'quote', text: quoted.join('\n') });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length) {
        const item = pattern.exec(lines[i]);
        if (item) {
          items.push(ordered ? item[2] : item[1]);
        } else if (items.length > 0 && /^\s{2,}\S/.test(lines[i]) && !startsBlock(lines[i])) {
          // An indented line continues the item above it.
          items[items.length - 1] += `\n${lines[i].trim()}`;
        } else {
          break;
        }
        i++;
      }
      blocks.push({ kind: 'list', ordered, start: numbered ? Number(numbered[1]) : 1, items });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i]) && !FENCE_OPEN.test(lines[i])) {
      paragraph.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}

/** Whether there's any block syntax to render, or the body is just inline text. */
function hasBlocks(blocks: Block[]): boolean {
  return blocks.some((block) => block.kind !== 'paragraph');
}

export function renderPostMarkdown(text: string, renderInline: (text: string) => ReactNode): ReactNode {
  const blocks = parsePostBlocks(text);
  if (!hasBlocks(blocks)) return renderInline(text);
  return (
    <div className="nu-markdown" data-nu-role="post-markdown">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'paragraph':
            return (
              <p key={i} className="nu-markdown__p">
                {renderInline(block.text)}
              </p>
            );
          case 'heading': {
            // A post's headings sit under the page's own: # is the biggest a post gets.
            const Tag = `h${Math.min(block.level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6';
            return (
              <Tag key={i} className={`nu-markdown__h nu-markdown__h${Math.min(block.level, 3)}`}>
                {renderInline(block.text)}
              </Tag>
            );
          }
          case 'quote':
            return (
              <blockquote key={i} className="nu-markdown__quote">
                {renderPostMarkdown(block.text, renderInline)}
              </blockquote>
            );
          case 'list': {
            const items = block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>);
            return block.ordered ? (
              <ol key={i} className="nu-markdown__list" start={block.start === 1 ? undefined : block.start}>
                {items}
              </ol>
            ) : (
              <ul key={i} className="nu-markdown__list">
                {items}
              </ul>
            );
          }
          case 'rule':
            return <hr key={i} className="nu-markdown__rule" />;
        }
      })}
    </div>
  );
}
