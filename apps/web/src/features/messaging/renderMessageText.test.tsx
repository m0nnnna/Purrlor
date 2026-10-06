import { describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import type { RoomMember } from 'matrix-js-sdk';
import { extractFirstUrl, renderMessageText } from './renderMessageText';
import type { MentionGroup } from '../../matrix/messageFormatting';

// Deliberately no emote-rendering cases here: EmoteImage pulls in useMediaUrl -> useMatrixClient,
// which would need a real (or heavily faked) MatrixClient just to render a plain <img>. The
// shortcode-matching logic it shares with everything else here is already covered directly by
// messageFormatting.test.ts, which exercises the identical regex/overlap algorithm without a
// client dependency — this file sticks to mentions and Markdown, neither of which need one.

function renderText(text: string, members: RoomMember[] = [], myUserId?: string) {
  return render(<div data-testid="out">{renderMessageText(text, [], members, myUserId)}</div>);
}

function fakeMember(userId: string, name: string): RoomMember {
  return { userId, name } as unknown as RoomMember;
}

describe('renderMessageText', () => {
  it('returns plain text unchanged when there is nothing to highlight', () => {
    const { getByTestId } = renderText('just a plain message');
    expect(getByTestId('out')).toHaveTextContent('just a plain message');
  });

  it('highlights a mention matching a room member', () => {
    const { container } = renderText('hey @Alice, got a sec?', [fakeMember('@alice:example.org', 'Alice')]);
    const mention = container.querySelector('.nu-mention');
    expect(mention).toHaveTextContent('@Alice');
    expect(mention).not.toHaveClass('nu-mention--me');
  });

  it('marks a mention of the current user distinctly', () => {
    const { container } = renderText('hey @Bob', [fakeMember('@bob:example.org', 'Bob')], '@bob:example.org');
    expect(container.querySelector('.nu-mention--me')).toHaveTextContent('@Bob');
  });

  it('highlights a member with no display name by their user ID, with a single @', () => {
    const { container } = renderText('ping @mino:example.org', [fakeMember('@mino:example.org', '@mino:example.org')]);
    expect(container.querySelector('.nu-mention')).toHaveTextContent(/^@mino:example\.org$/);
  });

  it('does not highlight a member name that only partially matches', () => {
    // "@AliceInWonderland" should not match a mention for member "Alice".
    const { container } = renderText('@AliceInWonderland is not a mention of Alice', [
      fakeMember('@alice:example.org', 'Alice'),
    ]);
    expect(container.querySelector('.nu-mention')).toBeNull();
  });

  it('renders bold, italic, code, strikethrough, and spoiler', () => {
    const { container } = renderText('**bold** *italic* `code` ~~gone~~ ||hidden||');
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('em')).toHaveTextContent('italic');
    expect(container.querySelector('code.nu-inline-code')).toHaveTextContent('code');
    expect(container.querySelector('del')).toHaveTextContent('gone');
    expect(container.querySelector('[data-nu-role="spoiler-text"]')).toHaveTextContent('hidden');
  });

  // Same regression as messageFormatting.test.ts, at the rendered-output level: a bold span
  // immediately followed by an italic one used to have the bold's trailing "* " bridge into
  // the italic's opening delimiter and swallow it as literal text.
  it('renders a bold span immediately followed by an italic span as two distinct elements', () => {
    const { container } = renderText('**bold** *italic*');
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('em')).toHaveTextContent('italic');
    expect(container.textContent).toBe('bold italic');
  });

  it('reveals spoiler text on click', () => {
    const { container } = renderText('||secret||');
    const spoiler = container.querySelector('[data-nu-role="spoiler-text"]') as HTMLElement;
    expect(spoiler).not.toHaveClass('nu-spoiler--revealed');
    fireEvent.click(spoiler);
    expect(spoiler).toHaveClass('nu-spoiler--revealed');
  });

  it('renders a fenced code block with a recognized language as highlighted markup', async () => {
    // Prism loads asynchronously (dynamic import, see CodeBlock.tsx) — the block renders plain
    // first, then re-renders highlighted once it's loaded.
    const { container } = renderText('```js\nconst x = 1;\n```');
    await waitFor(() => {
      expect(container.querySelector('[data-nu-role="code-block"] code')).toHaveClass('language-javascript');
    });
    expect(container.querySelector('[data-nu-role="code-block"] code')).toHaveTextContent('const x = 1;');
  });

  it('renders a fenced code block with no/unrecognized language as plain, unescaped text', () => {
    const { container } = renderText('```\n<b>not html</b>\n```');
    const code = container.querySelector('[data-nu-role="code-block"] code');
    expect(code?.className).toBe('');
    expect(code).toHaveTextContent('<b>not html</b>');
  });

  it('does not apply inline markdown inside a fenced code block', () => {
    const { container } = renderText('```\n**not bold**\n```');
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('[data-nu-role="code-block"]')).toHaveTextContent('**not bold**');
  });

  it('highlights a literal "@room" mass-mention regardless of member list', () => {
    const { container } = renderText('@room dinner is ready');
    const roomMention = container.querySelector('.nu-mention--room');
    expect(roomMention).toHaveTextContent('@room');
    expect(container.textContent).toBe('@room dinner is ready');
  });

  it('does not highlight "@roomy" as a room mention', () => {
    const { container } = renderText('@roomy is a username, not a mention');
    expect(container.querySelector('.nu-mention--room')).toBeNull();
  });

  it('renders a bare URL as a clickable link', () => {
    const { container } = renderText('check this out https://example.com/page it rules');
    const link = container.querySelector('a.nu-message-link');
    expect(link).toHaveAttribute('href', 'https://example.com/page');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.textContent).toBe('check this out https://example.com/page it rules');
  });

  it('excludes trailing sentence punctuation from a linkified URL', () => {
    const { container } = renderText('see https://example.com/page, or don\'t.');
    expect(container.querySelector('a.nu-message-link')).toHaveAttribute('href', 'https://example.com/page');
  });

  it('does not linkify a URL inside a fenced code block', () => {
    const { container } = renderText('```\nhttps://example.com\n```');
    expect(container.querySelector('a.nu-message-link')).toBeNull();
  });

  describe('extractFirstUrl', () => {
    it('returns the first bare URL in a message', () => {
      expect(extractFirstUrl('go to https://example.com then https://other.com')).toBe(
        'https://example.com'
      );
    });

    it('returns undefined when there is no URL', () => {
      expect(extractFirstUrl('no links here')).toBeUndefined();
    });

    // Regression: MessageTimeline calls extractFirstUrl(body) (to decide whether to show a
    // LinkPreviewCard) and then renderMessageText(body) (to linkify it) on the very same string,
    // in that order, every render. Both used to run off the same shared, stateful `g`-flagged
    // regex — extractFirstUrl's exec() left its lastIndex pointing past the match, and
    // matchAll (used internally by renderMessageText) clones a global regex's *current*
    // lastIndex, so the second call silently started scanning after the URL and found nothing.
    it('still linkifies the url in renderMessageText after extractFirstUrl already ran on the same text', () => {
      const text = 'check this out https://example.com neat huh';
      extractFirstUrl(text);
      const { container } = renderText(text);
      expect(container.querySelector('a.nu-message-link')).toHaveAttribute('href', 'https://example.com');
    });
  });
});

describe('renderMessageText: @everyone and roles', () => {
  it.each(['@everyone', '@everynyan'])('highlights %s like @room', (word) => {
    const { container } = renderText(`${word} dinner`);
    expect(container.querySelector('.nu-mention--room')).toHaveTextContent(word);
  });

  it('highlights a role mention, as yours when you hold the role', () => {
    const groups: MentionGroup[] = [{ id: 'moderator', names: ['Moderators', 'Moderator'], userIds: ['@me:x'] }];
    const mine = render(<div>{renderMessageText('@Moderators help', [], [], '@me:x', { mentionGroups: groups })}</div>);
    expect(mine.container.querySelector('.nu-mention--me')).toHaveTextContent('@Moderators');
    const theirs = render(<div>{renderMessageText('@moderator help', [], [], '@you:x', { mentionGroups: groups })}</div>);
    const span = theirs.container.querySelector('.nu-mention');
    expect(span).toHaveTextContent('@moderator');
    expect(span).not.toHaveClass('nu-mention--me');
  });
});
