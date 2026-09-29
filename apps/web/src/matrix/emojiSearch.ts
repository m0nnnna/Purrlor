import groups from 'unicode-emoji-json/data-by-group.json';

export type EmojiEntry = { emoji: string; name: string; slug: string };
type EmojiGroup = { name: string; slug: string; emojis: EmojiEntry[] };

const EMOJI_GROUPS = groups as EmojiGroup[];
const ALL_EMOJI: EmojiEntry[] = EMOJI_GROUPS.flatMap((group) => group.emojis);

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Unicode emoji (`unicode-emoji-json`, Unicode's own data) whose name or slug matches `query` —
 * the same name/slug search components/EmojiPicker.tsx does over its own grouped copy of this
 * data, pulled out here so useShortcodeAutocomplete.tsx (the composer's `:shortcode` dropdown)
 * can offer the same "anything else" fallback EmojiPicker's search box does, without either one
 * needing to know about the other.
 */
export function searchEmoji(query: string, limit = 8): EmojiEntry[] {
  const q = normalize(query);
  if (!q) return [];
  return ALL_EMOJI.filter((e) => normalize(e.name).includes(q) || normalize(e.slug).includes(q)).slice(0, limit);
}
