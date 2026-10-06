import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { renderMessageText } from '../messaging/renderMessageText';
import { parsePostBlocks, renderPostMarkdown } from './renderPostMarkdown';

function renderPost(text: string) {
  return render(<div data-testid="out">{renderPostMarkdown(text, (t) => renderMessageText(t, []))}</div>);
}

describe('parsePostBlocks', () => {
  it('reads headings, lists, quotes and rules', () => {
    expect(parsePostBlocks('# Title\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n> more\n\n---\n\nplain')).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'list', ordered: false, start: 1, items: ['one', 'two'] },
      { kind: 'list', ordered: true, start: 1, items: ['first', 'second'] },
      { kind: 'quote', text: 'quoted\nmore' },
      { kind: 'rule' },
      { kind: 'paragraph', text: 'plain' },
    ]);
  });

  it('keeps a paragraph’s line breaks', () => {
    expect(parsePostBlocks('line one\nline two')).toEqual([{ kind: 'paragraph', text: 'line one\nline two' }]);
  });

  it('leaves hashtags, italics and bold at the start of a line alone', () => {
    const blocks = parsePostBlocks('#caturday\n*italic* start\n**bold** start');
    expect(blocks).toEqual([{ kind: 'paragraph', text: '#caturday\n*italic* start\n**bold** start' }]);
  });

  it('never splits a fenced code block', () => {
    const blocks = parsePostBlocks('```\n# not a heading\n- not a list\n```\n- a list');
    expect(blocks[0]).toEqual({ kind: 'paragraph', text: '```\n# not a heading\n- not a list\n```' });
    expect(blocks[1]).toEqual({ kind: 'list', ordered: false, start: 1, items: ['a list'] });
  });

  it('starts a numbered list where the author did', () => {
    expect(parsePostBlocks('3. third\n4. fourth')).toEqual([{ kind: 'list', ordered: true, start: 3, items: ['third', 'fourth'] }]);
  });
});

describe('renderPostMarkdown', () => {
  it('hands a body without blocks straight to the inline renderer', () => {
    const { getByTestId, container } = renderPost('just **text**');
    expect(container.querySelector('.nu-markdown')).toBeNull();
    expect(getByTestId('out').querySelector('strong')).toHaveTextContent('text');
  });

  it('renders blocks with inline Markdown inside them', () => {
    const { container } = renderPost('## Hello **there**\n\n- [site](https://example.org)\n- *two*\n\n> wise words');
    expect(container.querySelector('h4')).toHaveTextContent('Hello there');
    expect(container.querySelector('h4 strong')).toHaveTextContent('there');
    const link = container.querySelector('ul a');
    expect(link).toHaveTextContent('site');
    expect(link).toHaveAttribute('href', 'https://example.org');
    expect(container.querySelector('ul em')).toHaveTextContent('two');
    expect(container.querySelector('blockquote')).toHaveTextContent('wise words');
  });
});
