import { useState, type KeyboardEvent, type RefObject } from 'react';
import type { Emote } from '../../matrix/emotes';
import { searchEmoji } from '../../matrix/emojiSearch';
import { EmoteImage } from './EmoteImage';
import './Composer.css';

const MAX_SHORTCODE_SUGGESTIONS = 8;
/** ":" then at least two shortcode characters, up to the cursor. The two-character minimum
 *  (unlike `useMentionAutocomplete`'s trigger, which fires on a bare "@") is deliberate: a colon
 *  alone, or with one character after it, is common enough in ordinary typing (a smiley ":)", a
 *  clock "3:14") that suggesting on it would be noisy rather than useful. */
const SHORTCODE_TRIGGER_PATTERN = /(?:^|\s):([a-zA-Z0-9_+-]{2,})$/;

/** One row in the dropdown: either a custom emote (`mxcUrl` set) or a plain Unicode emoji
 *  (`emoji` set) — never both. */
export type ShortcodeSuggestion = { shortcode: string; mxcUrl?: string; emoji?: string };

/**
 * `:shortcode` autocomplete for the chat composer — mirrors `useMentionAutocomplete.tsx` one for
 * one (same `update`/`handleKeyDown`/`close`/`reset`/`dropdown` shape, same arrow-key/Enter/Tab/
 * Escape behavior, same `onMouseDown`+`preventDefault` trick so clicking a suggestion doesn't
 * blur the textarea before `select` can read its cursor position) rather than being a new design,
 * so the two autocompletes feel like one feature to type with. Suggests this room's own custom
 * emotes first, then — if any name/slug matches too — plain Unicode emoji (emojiSearch.ts, the
 * same data EmojiPicker's own search box uses), so `:fire` finds both a `:fire:` custom emote and
 * 🔥. Picking either inserts it in place of the typed `:query`, the same `:shortcode: ` text a
 * custom emote gets from EmojiAndEmotePicker's own emote tab (Composer.tsx's `onPickEmote`) for a
 * custom emote, or the bare character for a Unicode one — each followed by a trailing space so
 * typing can continue right away, matching the mention insertion's own `@Name ` convention.
 */
export function useShortcodeAutocomplete({
  text,
  setText,
  textareaRef,
  emotes,
}: {
  text: string;
  setText: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  emotes: Emote[];
}) {
  const [query, setQuery] = useState<string | null>(null);
  const [index, setIndex] = useState(0);

  const matches: ShortcodeSuggestion[] =
    query === null
      ? []
      : [
          ...emotes
            .filter((emote) => emote.shortcode.toLowerCase().includes(query.toLowerCase()))
            .map((emote): ShortcodeSuggestion => ({ shortcode: emote.shortcode, mxcUrl: emote.mxcUrl })),
          ...searchEmoji(query).map((entry): ShortcodeSuggestion => ({ shortcode: entry.slug, emoji: entry.emoji })),
        ].slice(0, MAX_SHORTCODE_SUGGESTIONS);

  /** Call on every change, with the new value and where the cursor is. */
  const update = (value: string, cursor: number) => {
    const match = SHORTCODE_TRIGGER_PATTERN.exec(value.slice(0, cursor));
    setQuery(match ? match[1] : null);
    setIndex(0);
  };

  const select = (suggestion: ShortcodeSuggestion) => {
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? text.length;
    const match = SHORTCODE_TRIGGER_PATTERN.exec(text.slice(0, cursor));
    if (!match) return;
    // match[0] is "<ws-or-start>:query" — the ':' itself starts right before the query capture.
    const colonIndex = cursor - match[1].length - 1;
    const before = text.slice(0, colonIndex);
    const after = text.slice(cursor);
    const inserted = suggestion.mxcUrl !== undefined ? `:${suggestion.shortcode}: ` : `${suggestion.emoji} `;
    setText(`${before}${inserted}${after}`);
    setQuery(null);
    requestAnimationFrame(() => {
      const pos = before.length + inserted.length;
      textarea?.focus();
      textarea?.setSelectionRange(pos, pos);
    });
  };

  /** Arrow keys, Enter/Tab and Escape while the dropdown is open. True when it handled the key. */
  const handleKeyDown = (evt: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (query === null || matches.length === 0) return false;
    if (evt.key === 'ArrowDown') {
      evt.preventDefault();
      setIndex((i) => (i + 1) % matches.length);
      return true;
    }
    if (evt.key === 'ArrowUp') {
      evt.preventDefault();
      setIndex((i) => (i - 1 + matches.length) % matches.length);
      return true;
    }
    if (evt.key === 'Enter' || evt.key === 'Tab') {
      evt.preventDefault();
      select(matches[index]);
      return true;
    }
    if (evt.key === 'Escape') {
      evt.preventDefault();
      setQuery(null);
      return true;
    }
    return false;
  };

  /** Hides the dropdown without touching the draft (a failed send restores it as-is). */
  const close = () => setQuery(null);

  /** After a successful send: no dropdown carries over into the next draft. */
  const reset = () => setQuery(null);

  const dropdown =
    query !== null && matches.length > 0 ? (
      <div className="nu-composer__mentions" data-nu-role="composer-shortcodes">
        {matches.map((suggestion, i) => (
          <button
            key={suggestion.mxcUrl ?? suggestion.emoji ?? suggestion.shortcode}
            type="button"
            className={
              i === index ? 'nu-composer__mention-item nu-composer__mention-item--active' : 'nu-composer__mention-item'
            }
            data-nu-role="composer-shortcode-item"
            onMouseDown={(evt) => {
              evt.preventDefault(); // keep textarea focus so select can read its selection
              select(suggestion);
            }}
          >
            {suggestion.mxcUrl !== undefined ? (
              <EmoteImage shortcode={suggestion.shortcode} mxcUrl={suggestion.mxcUrl} />
            ) : (
              <span aria-hidden="true">{suggestion.emoji}</span>
            )}
            <span>:{suggestion.shortcode}:</span>
          </button>
        ))}
      </div>
    ) : null;

  return { update, handleKeyDown, close, reset, dropdown };
}
