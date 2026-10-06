import { describe, expect, it } from 'vitest';
import { buildMessageFormatting, parseFormattedBodyEmotes, type MentionGroup } from './messageFormatting';
import type { Emote } from './emotes';

const EMOTES: Emote[] = [{ shortcode: 'blob', mxcUrl: 'mxc://example.org/blob' }];

describe('buildMessageFormatting', () => {
  it('returns no formatted body for plain text with no emotes/mentions/markdown', () => {
    const result = buildMessageFormatting('just plain text', [], []);
    expect(result.formattedBody).toBeUndefined();
    expect(result.mentionedUserIds).toEqual([]);
  });

  it('embeds a known emote as an MSC2545 image, leaving unknown shortcodes as literal text', () => {
    const result = buildMessageFormatting('hi :blob: and :unknown:', EMOTES, []);
    expect(result.formattedBody).toContain('<img data-mx-emoticon src="mxc://example.org/blob"');
    expect(result.formattedBody).toContain(':unknown:');
  });

  it('links a mention to the matrix.to URI and reports the mentioned user id', () => {
    const result = buildMessageFormatting('hey @Alice how are you', [], [{ userId: '@alice:example.org', displayName: 'Alice' }]);
    expect(result.formattedBody).toBe('hey <a href="https://matrix.to/#/@alice:example.org">@Alice</a> how are you');
    expect(result.mentionedUserIds).toEqual(['@alice:example.org']);
  });

  it('does not treat an arbitrary "@word" as a mention unless it was a provided candidate', () => {
    const result = buildMessageFormatting('email me @not-a-mention please', [], []);
    expect(result.formattedBody).toBeUndefined();
    expect(result.mentionedUserIds).toEqual([]);
  });

  it('renders bold, italic (both delimiters), code, strikethrough, and spoiler', () => {
    const result = buildMessageFormatting('**bold** *italic* _also italic_ `code` ~~strike~~ ||spoiler||', [], []);
    expect(result.formattedBody).toBe(
      '<strong>bold</strong> <em>italic</em> <em>also italic</em> <code>code</code> <del>strike</del> <span data-mx-spoiler>spoiler</span>'
    );
  });

  // Regression test for a real bug found while building this: naively scanning for `*text*`
  // italics independently of `**text**` bold produced a spurious match on the single leftover
  // "*" plus the following space right after a bold span, which then consumed the *next* real
  // italic's opening delimiter and swallowed it as literal text instead of rendering it.
  it('does not let a bold span swallow the italic that immediately follows it', () => {
    const result = buildMessageFormatting('**bold** *italic*', [], []);
    expect(result.formattedBody).toBe('<strong>bold</strong> <em>italic</em>');
  });

  it('does not treat a lone stray asterisk as italic (no matching close)', () => {
    const result = buildMessageFormatting('this * is just an asterisk', [], []);
    expect(result.formattedBody).toBeUndefined();
  });

  it('does not open emphasis on whitespace immediately inside the delimiters', () => {
    // "* not italic *" has a space right after the opening and right before the closing star,
    // which real Markdown (and this app's own rule) treats as not-emphasis.
    const result = buildMessageFormatting('* not italic *', [], []);
    expect(result.formattedBody).toBeUndefined();
  });

  it('HTML-escapes plain text and markdown/mention content alike', () => {
    const result = buildMessageFormatting('<script> & **<b>bold</b>**', [], []);
    expect(result.formattedBody).toBe('&lt;script&gt; &amp; <strong>&lt;b&gt;bold&lt;/b&gt;</strong>');
  });

  it('combines emotes, mentions, and markdown in one pass without double-escaping the rest', () => {
    const result = buildMessageFormatting('@Alice **hi** :blob:', EMOTES, [
      { userId: '@alice:example.org', displayName: 'Alice' },
    ]);
    expect(result.formattedBody).toBe(
      '<a href="https://matrix.to/#/@alice:example.org">@Alice</a> <strong>hi</strong> <img data-mx-emoticon src="mxc://example.org/blob" alt=":blob:" title=":blob:" height="32" />'
    );
    expect(result.mentionedUserIds).toEqual(['@alice:example.org']);
  });

  it('keeps the earlier of two overlapping matches and treats the rest of that span as literal', () => {
    // A code span should not have markdown parsed inside it.
    const result = buildMessageFormatting('`**not bold**`', [], []);
    expect(result.formattedBody).toBe('<code>**not bold**</code>');
  });

  it('renders a fenced code block with a language tag as a classed <pre><code>', () => {
    const result = buildMessageFormatting('```js\nconst x = 1;\n```', [], []);
    expect(result.formattedBody).toBe('<pre><code class="language-js">const x = 1;\n</code></pre>');
  });

  it('renders a fenced code block with no language tag as a plain <pre><code>', () => {
    const result = buildMessageFormatting('```\nplain\n```', [], []);
    expect(result.formattedBody).toBe('<pre><code>plain\n</code></pre>');
  });

  it('does not apply inline markdown or a bare code span inside a fenced block', () => {
    const result = buildMessageFormatting('```\n**not bold** `not code`\n```', [], []);
    expect(result.formattedBody).toBe('<pre><code>**not bold** `not code`\n</code></pre>');
  });

  it('HTML-escapes fenced code block content', () => {
    const result = buildMessageFormatting('```html\n<b>x</b>\n```', [], []);
    expect(result.formattedBody).toBe('<pre><code class="language-html">&lt;b&gt;x&lt;/b&gt;\n</code></pre>');
  });

  it('does not treat "@room" as a mass-mention without permission, even if literally typed', () => {
    const result = buildMessageFormatting('@room please look at this', [], [], false);
    expect(result.mentionsRoom).toBe(false);
    expect(result.formattedBody).toBeUndefined();
  });

  it('treats "@room" as a mass-mention when permitted, highlighting it in formatted_body', () => {
    const result = buildMessageFormatting('@room please look at this', [], [], true);
    expect(result.mentionsRoom).toBe(true);
    expect(result.formattedBody).toBe('<strong>@room</strong> please look at this');
  });

  it('does not match "@roomy" as a room mention (word boundary)', () => {
    const result = buildMessageFormatting('@roomy is not a room mention', [], [], true);
    expect(result.mentionsRoom).toBe(false);
  });

  it('does not leak state across repeated calls (shared global regex lastIndex bug)', () => {
    // Two calls in a row that both should match — a regression test for reusing a module-level
    // `g`-flagged RegExp across invocations without resetting its lastIndex.
    const first = buildMessageFormatting('@room hello', [], [], true);
    const second = buildMessageFormatting('@room hello again', [], [], true);
    expect(first.mentionsRoom).toBe(true);
    expect(second.mentionsRoom).toBe(true);
  });
});

describe('parseFormattedBodyEmotes', () => {
  it('reads shortcode -> mxc pairs out of a formatted_body this app itself would have written', () => {
    const html = '<img data-mx-emoticon src="mxc://example.org/blob" alt=":blob:" title=":blob:" height="32" />';
    expect(parseFormattedBodyEmotes(html)).toEqual([{ shortcode: 'blob', mxcUrl: 'mxc://example.org/blob' }]);
  });

  it('falls back to title when there is no alt, and tolerates attribute order/quoting', () => {
    const html = `<img height='32' title=':cat:' data-mx-emoticon src='mxc://example.org/cat'/>`;
    expect(parseFormattedBodyEmotes(html)).toEqual([{ shortcode: 'cat', mxcUrl: 'mxc://example.org/cat' }]);
  });

  it('returns nothing for a plain body with no HTML at all', () => {
    expect(parseFormattedBodyEmotes(undefined)).toEqual([]);
    expect(parseFormattedBodyEmotes('just text, no img tags')).toEqual([]);
  });

  it('ignores an <img> without data-mx-emoticon, even one that looks similar', () => {
    const html = '<img src="mxc://example.org/x" alt=":not-an-emote:" />';
    expect(parseFormattedBodyEmotes(html)).toEqual([]);
  });

  it('only ever accepts an mxc:// src, never http(s) or anything else', () => {
    const html = '<img data-mx-emoticon src="https://evil.example/x.png" alt=":evil:" />';
    expect(parseFormattedBodyEmotes(html)).toEqual([]);
  });

  it('drops an image on the global library\'s hidden list', () => {
    const html = '<img data-mx-emoticon src="mxc://example.org/hidden" alt=":hidden:" />';
    expect(parseFormattedBodyEmotes(html, new Set(['mxc://example.org/hidden']))).toEqual([]);
  });

  it('reads several emoticon images out of the same message, keeping the first of a repeated shortcode', () => {
    const html =
      '<img data-mx-emoticon src="mxc://example.org/a" alt=":a:" /> hi ' +
      '<img data-mx-emoticon src="mxc://example.org/b" alt=":b:" /> ' +
      '<img data-mx-emoticon src="mxc://example.org/a2" alt=":a:" />';
    expect(parseFormattedBodyEmotes(html)).toEqual([
      { shortcode: 'a', mxcUrl: 'mxc://example.org/a' },
      { shortcode: 'b', mxcUrl: 'mxc://example.org/b' },
    ]);
  });

  it('decodes HTML entities in the shortcode attribute', () => {
    const html = '<img data-mx-emoticon src="mxc://example.org/x" alt="&amp;cat&amp;" />';
    // The shortcode charset this app allows never actually includes "&", but a foreign client's
    // pack isn't bound by that — decoding still shouldn't crash, and the colons still get trimmed.
    expect(parseFormattedBodyEmotes(html)).toEqual([{ shortcode: '&cat&', mxcUrl: 'mxc://example.org/x' }]);
  });
});

describe('@everyone and role mentions', () => {
  const MODS: MentionGroup = { id: 'moderator', names: ['Moderators', 'Moderator'], userIds: ['@a:x', '@b:x'] };

  it.each(['@everyone', '@everynyan', '@Everyone', '@room'])('treats %s as a mass-mention when permitted', (word) => {
    const result = buildMessageFormatting(`${word} dinner`, [], [], true);
    expect(result.mentionsRoom).toBe(true);
    expect(result.formattedBody).toBe(`<strong>${word}</strong> dinner`);
  });

  it('needs the power to mention the room for @everyone too', () => {
    expect(buildMessageFormatting('@everyone dinner', [], [], false).mentionsRoom).toBe(false);
  });

  it('does not take @everyoneelse or a user ID for @everyone', () => {
    expect(buildMessageFormatting('@everyoneelse hi', [], [], true).mentionsRoom).toBe(false);
    expect(buildMessageFormatting('@everyone:cats.example hi', [], [], true).mentionsRoom).toBe(false);
  });

  it('mentions everyone holding a role, by either of its names', () => {
    for (const text of ['@Moderators help', 'help @moderator']) {
      const result = buildMessageFormatting(text, [], [], false, [MODS]);
      expect(result.mentionedUserIds).toEqual(['@a:x', '@b:x']);
      expect(result.formattedBody).toContain('<strong>');
    }
  });

  it('merges a role mention with a person mentioned by name', () => {
    const result = buildMessageFormatting('@Moderators and @Cy', [], [{ userId: '@c:x', displayName: 'Cy' }], false, [MODS]);
    expect(result.mentionedUserIds).toEqual(['@a:x', '@b:x', '@c:x']);
  });

  it('does not mention a role inside a code span', () => {
    const result = buildMessageFormatting('`@Moderators`', [], [], false, [MODS]);
    expect(result.mentionedUserIds).toEqual([]);
  });

  it('ignores a role nobody holds', () => {
    const result = buildMessageFormatting('@Helpers', [], [], false, [{ id: 'custom:h', names: ['Helpers'], userIds: [] }]);
    expect(result.mentionedUserIds).toEqual([]);
    expect(result.formattedBody).toBeUndefined();
  });
});
