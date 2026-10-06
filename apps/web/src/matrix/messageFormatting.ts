import type { Emote } from './emotes';
import { fallbackName } from './displayName';

const SHORTCODE_PATTERN = /:([a-zA-Z0-9_+-]+):/g;

// Mirrors renderMessageText.tsx's receive-side parsing of the same syntax straight from plain
// text — kept here too so other clients (Element etc.) render the formatting as well, via the
// `formatted_body` this produces. See that file for why overlap/priority falls out of sorting
// by match *index* rather than needing explicit precedence rules.
// Matched (and its span claimed) before CODE_PATTERN gets a chance at it, same reasoning as
// renderMessageText.tsx's identical pattern — a fence's content shouldn't also get inline
// formatting applied inside it.
const FENCE_PATTERN = /```(\w*)\n?([\s\S]*?)```/g;
const CODE_PATTERN = /`([^`\n]+)`/g;
const LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s()<>"]+)\)/g;
const BOLD_PATTERN = /\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g;
const STRIKE_PATTERN = /~~(?!\s)([^~\n]+?)(?<!\s)~~/g;
const SPOILER_PATTERN = /\|\|(?!\s)([^|\n]+?)(?<!\s)\|\|/g;
const ITALIC_STAR_PATTERN = /\*(?!\s)([^*\n]+?)(?<!\s)\*/g;
const ITALIC_UNDERSCORE_PATTERN = /_(?!\s)([^_\n]+?)(?<!\s)_/g;
// MSC3952's `m.mentions.room` is the modern notify signal, but legacy clients still notify off
// this literal text in the plain `body` (the old `@room` push-rule condition) — keeping it in
// body as typed is what makes this interoperate with clients that predate intentional mentions.
// `@everyone` (what Discord people type) and `@everynyan` (for fun) are the same mass-mention;
// only `@room` also notifies those legacy clients, the others rely on `m.mentions.room`.
// Not part of a longer word or a user ID: `@roomy` and `@everyone:cats.example` are people.
export const ROOM_MENTION_PATTERN = /(?<![\p{L}\p{N}_])@(?:room|everyone|everynyan)(?![\p{L}\p{N}_]|:[\p{L}\p{N}])/giu;

/** The mass-mentions, in the order the composer's autocomplete offers them. */
export const ROOM_MENTIONS = ['everyone', 'everynyan', 'room'] as const;

export type MentionCandidate = { userId: string; displayName: string };

/** A role mentioned by name, "@Moderators": a mention of everyone holding it (roles.ts's
 *  roleMentionGroups). `names` are the ways to write it, without the "@". */
export type MentionGroup = { id: string; names: string[]; userIds: string[] };

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type Replacement = { index: number; length: number; html: string; mentionedUserIds?: string[] };

/**
 * A single combined pass over the composer's plain text that finds `:shortcode:` emotes
 * (MSC2545, see emotes.ts), `@DisplayName` mentions (only for names actually inserted via the
 * composer's autocomplete — see Composer.tsx's mentionedRef — not any arbitrary "@word" someone
 * typed by hand), a literal `@room` mass-mention (gated on `canMentionRoom`, from
 * `permissions.ts`'s power-level check — unlike a name, nobody types "@room" by accident, so no
 * autocomplete-selection gate is needed the way a coincidental name match would need one), and
 * basic inline Markdown (bold/italic/code/strikethrough/spoiler) — producing one `formatted_body`
 * for all of it. Combining them in one pass (rather than several independent escape-and-replace
 * passes chained together) avoids double-escaping the parts neither transform touches, and gives
 * the same "whichever match starts first wins" overlap behavior renderMessageText.tsx uses on
 * the receive side, so what you see in the composer preview-lessly matches what actually gets
 * sent. Mentions also report back which user IDs actually matched (for `m.mentions.user_ids`)
 * and whether `@room` matched (for `m.mentions.room`, MSC3952) — the actual notification-
 * triggering signals, independent of whether a formatted_body ends up needed at all.
 */
export function buildMessageFormatting(
  text: string,
  emotes: Emote[],
  mentions: MentionCandidate[],
  canMentionRoom = false,
  groups: MentionGroup[] = []
): { formattedBody?: string; mentionedUserIds: string[]; mentionsRoom: boolean } {
  const replacements: Replacement[] = [];
  // Unlike a @DisplayName mention, typing "@room" is never an accident someone would want
  // undone the way a coincidental name match would be — no autocomplete-selection gate needed,
  // just the power-level check (canMentionRoom, from permissions.ts) a real mass-mention needs.
  // Collected via matchAll (which clones the regex internally) rather than a stray .test() call
  // on this shared module-level `g`-flagged pattern, whose mutated lastIndex would otherwise
  // leak into the next call and intermittently miss a real match.
  const roomMentionMatches = canMentionRoom ? [...text.matchAll(ROOM_MENTION_PATTERN)] : [];
  const mentionsRoom = roomMentionMatches.length > 0;
  for (const match of roomMentionMatches) {
    replacements.push({ index: match.index, length: match[0].length, html: `<strong>${escapeHtml(match[0])}</strong>` });
  }

  if (emotes.length > 0) {
    const byShortcode = new Map(emotes.map((emote) => [emote.shortcode, emote]));
    for (const match of text.matchAll(SHORTCODE_PATTERN)) {
      const emote = byShortcode.get(match[1]);
      if (!emote) continue;
      replacements.push({
        index: match.index,
        length: match[0].length,
        html: `<img data-mx-emoticon src="${emote.mxcUrl}" alt=":${emote.shortcode}:" title=":${emote.shortcode}:" height="32" />`,
      });
    }
  }

  for (const found of findMentions(text, mentions.map((m) => ({ text: mentionText(m.displayName), userId: m.userId })))) {
    replacements.push({
      index: found.index,
      length: found.length,
      html: `<a href="https://matrix.to/#/${found.userId}">${escapeHtml(text.slice(found.index, found.index + found.length))}</a>`,
      mentionedUserIds: [found.userId],
    });
  }

  // A role mention notifies each person holding it, as an ordinary user mention: Matrix has no
  // role mentions of its own. Pushed after the people, so a person who happens to share a role's
  // name keeps the mention (the sort below is stable).
  for (const found of findGroupMentions(text, groups)) {
    replacements.push({
      index: found.index,
      length: found.length,
      html: `<strong>${escapeHtml(text.slice(found.index, found.index + found.length))}</strong>`,
      mentionedUserIds: found.group.userIds,
    });
  }

  for (const match of text.matchAll(FENCE_PATTERN)) {
    const lang = match[1];
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    replacements.push({
      index: match.index,
      length: match[0].length,
      // Plain CommonMark/Matrix-HTML-subset fenced-block markup (no embedded highlighting
      // markup) — a receiving client applies its own syntax highlighting from the language-x
      // class, same convention Element and most other Matrix clients follow.
      html: `<pre><code${langAttr}>${escapeHtml(match[2])}</code></pre>`,
    });
  }

  for (const match of text.matchAll(LINK_PATTERN)) {
    replacements.push({
      index: match.index,
      length: match[0].length,
      html: `<a href="${escapeHtml(match[2]).replace(/"/g, '&quot;')}">${escapeHtml(match[1])}</a>`,
    });
  }

  const markdownTags: [RegExp, (inner: string) => string][] = [
    [CODE_PATTERN, (inner) => `<code>${escapeHtml(inner)}</code>`],
    [BOLD_PATTERN, (inner) => `<strong>${escapeHtml(inner)}</strong>`],
    [STRIKE_PATTERN, (inner) => `<del>${escapeHtml(inner)}</del>`],
    [SPOILER_PATTERN, (inner) => `<span data-mx-spoiler>${escapeHtml(inner)}</span>`],
    [ITALIC_STAR_PATTERN, (inner) => `<em>${escapeHtml(inner)}</em>`],
    [ITALIC_UNDERSCORE_PATTERN, (inner) => `<em>${escapeHtml(inner)}</em>`],
  ];
  for (const [pattern, render] of markdownTags) {
    for (const match of text.matchAll(pattern)) {
      replacements.push({ index: match.index, length: match[0].length, html: render(match[1]) });
    }
  }

  if (replacements.length === 0) return { mentionedUserIds: [], mentionsRoom };

  replacements.sort((a, b) => a.index - b.index);

  let html = '';
  let lastIndex = 0;
  const mentioned = new Set<string>();
  for (const replacement of replacements) {
    if (replacement.index < lastIndex) continue; // overlapping match — keep the earlier one
    // Only a mention that survived the overlap counts: `@Mods` inside a code span isn't one.
    for (const userId of replacement.mentionedUserIds ?? []) mentioned.add(userId);
    html += escapeHtml(text.slice(lastIndex, replacement.index));
    html += replacement.html;
    lastIndex = replacement.index + replacement.length;
  }
  html += escapeHtml(text.slice(lastIndex));

  return { formattedBody: html, mentionedUserIds: [...mentioned], mentionsRoom };
}

/** Where `text` mentions any of `groups` by one of its names, ignoring case. Same word edges as a
 *  person's mention (findMentions). A group nobody holds is never a mention. */
export function findGroupMentions(text: string, groups: MentionGroup[]): { index: number; length: number; group: MentionGroup }[] {
  const byName = new Map<string, MentionGroup>();
  for (const group of groups) {
    if (group.userIds.length === 0) continue;
    for (const name of group.names) {
      const key = `@${name}`.toLowerCase();
      if (name && !byName.has(key)) byName.set(key, group);
    }
  }
  if (byName.size === 0 || !text.includes('@')) return [];
  const alternatives = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp(`${MENTION_START}(?:${alternatives.join('|')})${MENTION_END}`, 'giu');
  return [...text.matchAll(pattern)].map((match) => ({
    index: match.index,
    length: match[0].length,
    group: byName.get(match[0].toLowerCase()) as MentionGroup,
  }));
}

// Matches only the exact shape this app's own `buildMessageFormatting` above writes, and the one
// Element/cinny write compatibly (both MSC2545-adjacent): a self-closing <img> somewhere carrying
// `data-mx-emoticon`. Attribute order isn't assumed, so `\b...\b` finds it anywhere in the tag.
const EMOTICON_IMG_PATTERN = /<img\b[^>]*\bdata-mx-emoticon\b[^>]*>/gi;

function readAttr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? (match[1] ?? match[2]) : undefined;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/**
 * Shortcode -> mxc URL pairs straight out of a message's own `formatted_body`, so
 * renderMessageText.tsx can render the emote the *sender* actually meant — their own room/Space
 * pack, a personal MSC2545 pack (emotes.ts doesn't cover those; see readUserEmotePacks.ts), or an
 * Element/cinny user's pack — rather than only ones that happen to also be in the reader's own
 * list, which is all it used to draw from. (A personal MSC2545 pack the *reader* subscribes to —
 * personalEmotePacks.ts — is merged into that reader-side list separately; this is only about
 * what the message itself carries.) Reads exactly three attributes off a matching
 * `<img data-mx-emoticon>` tag (`src`, plus `alt` or `title` for the shortcode) and nothing else
 * in the HTML; renderMessageText.tsx's own comment explains why formatted_body is otherwise never
 * rendered. Only an `mxc://` `src` is ever accepted, and `hiddenMxcUrls` (the global library's
 * moderation list, emoteLibrary.ts) drops anything a moderator has hidden even though it isn't in
 * any list this reader already filters. A duplicate shortcode in one message keeps its first
 * pairing.
 */
export function parseFormattedBodyEmotes(formattedBody: string | undefined, hiddenMxcUrls: Set<string> = new Set()): Emote[] {
  if (!formattedBody) return [];
  const emotes: Emote[] = [];
  const seen = new Set<string>();
  for (const match of formattedBody.matchAll(EMOTICON_IMG_PATTERN)) {
    const tag = match[0];
    const src = readAttr(tag, 'src');
    if (!src || !src.startsWith('mxc://') || hiddenMxcUrls.has(src)) continue;
    const rawCode = readAttr(tag, 'alt') ?? readAttr(tag, 'title');
    if (!rawCode) continue;
    const shortcode = decodeEntities(rawCode).replace(/^:|:$/g, '').trim();
    if (!shortcode || seen.has(shortcode)) continue;
    seen.add(shortcode);
    emotes.push({ shortcode, mxcUrl: src });
  }
  return emotes;
}

/** How a mention of this name reads in a message: "@Alice". Someone with no display name goes by
 *  their user ID, which already starts with "@", and prefixing another one gave "@@alice:server". */
export function mentionText(name: string): string {
  return name.startsWith('@') ? name : `@${name}`;
}

/** One way of writing a mention of someone, `@` included: "@Luna", "@luna", "@luna:cats.example". */
export type MentionTarget = { text: string; userId: string };

/**
 * Every way a person can be @-mentioned by typing: their name, their handle (`luna`, or
 * `luna:cats.example` for another server's people, displayName.ts) and their full user ID. Typing
 * any of them in full is as deliberate as picking the name from the dropdown, so it's a mention too.
 */
export function mentionCandidatesFor(people: { userId: string; name: string }[]): MentionCandidate[] {
  return people.flatMap(({ userId, name }) => [
    ...(name ? [{ userId, displayName: name }] : []),
    { userId, displayName: fallbackName(userId) },
    { userId, displayName: userId },
  ]);
}

// A mention starts where a word doesn't (so `me@luna.example` isn't one), and ends where the next
// character isn't a letter, a digit, `_`, or a `:` going on into a server name: `@luna` is not a
// mention of a local luna inside `@luna:cats.example`. Unicode-aware, so a name ending in an
// accented letter, an emoji or a `)` still matches, which `\b` (ASCII word characters only) didn't.
const MENTION_START = String.raw`(?<![\p{L}\p{N}_])`;
const MENTION_END = String.raw`(?![\p{L}\p{N}_]|:[\p{L}\p{N}])`;

/**
 * Where `text` mentions any of `targets`, ignoring case. One pattern for all of them, longest
 * first, so `@iNSo (@inso:server)` wins over `@iNSo`, and a full user ID over its handle. The
 * first target given for a piece of text decides who it is.
 */
export function findMentions(text: string, targets: MentionTarget[]): { index: number; length: number; userId: string }[] {
  const byText = new Map<string, string>();
  for (const target of targets) {
    const key = target.text.toLowerCase();
    if (target.text.length > 1 && !byText.has(key)) byText.set(key, target.userId);
  }
  if (byText.size === 0 || !text.includes('@')) return [];
  const alternatives = [...byText.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp(`${MENTION_START}(?:${alternatives.join('|')})${MENTION_END}`, 'giu');
  return [...text.matchAll(pattern)].map((match) => ({
    index: match.index,
    length: match[0].length,
    userId: byText.get(match[0].toLowerCase()) as string,
  }));
}

// A mention link the way Matrix clients write them: <a href="https://matrix.to/#/@user:server">Name</a>.
// The ID may be URL-encoded (`%40luna%3Acats.example`), as some clients write it.
const MENTION_LINK_PATTERN = /<a\b[^>]*\bhref\s*=\s*["']https:\/\/matrix\.to\/#\/((?:@|%40)[^"'/?]+)["'][^>]*>([^<]{1,255})<\/a>/gi;

/**
 * The mentions a message's own `formatted_body` links, as written: what the sender's client
 * meant, so the reader can highlight them even when the person isn't a member here (a Global
 * post's mention, say). Only the link's user ID and its text are read; the HTML is never rendered.
 */
export function parseFormattedBodyMentions(formattedBody: string | undefined): MentionTarget[] {
  if (!formattedBody) return [];
  const targets: MentionTarget[] = [];
  for (const match of formattedBody.matchAll(MENTION_LINK_PATTERN)) {
    let userId: string;
    try {
      userId = decodeURIComponent(match[1]);
    } catch {
      continue;
    }
    const label = decodeEntities(match[2]).trim();
    if (label && userId.startsWith('@')) targets.push({ text: mentionText(label), userId });
  }
  return targets;
}
