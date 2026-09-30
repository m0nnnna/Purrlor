import { PushRuleKind, type IPushRule, type IPushRules, type MatrixClient } from 'matrix-js-sdk';

/**
 * Words that notify you wherever they appear: your nickname, a project's name, the thing you're
 * waiting to hear about. Each is a Matrix `content` push rule whose ID is the word, the convention
 * Element and Cinny use for the same setting, so the list is shared with them. Being push rules,
 * they're applied by the homeserver: unread badges, desktop notifications and background push all
 * follow without knowing about this module (docs/notification-settings.md). Matching is the
 * homeserver's: a whole word, case-insensitive, `*` and `?` as wildcards.
 *
 * Order of the rules decides how they mix with a channel's level: content rules run after a
 * channel's "Nothing" (an override) and before its "Only @mentions" (a room rule), so a keyword
 * still notifies in a channel set to mentions only, and stays quiet in one that's muted.
 */

export const MAX_KEYWORDS = 30;
const MAX_KEYWORD_LENGTH = 50;

/** What Element writes for a keyword: notify, with the highlight and sound of a mention. */
const KEYWORD_ACTIONS = ['notify', { set_tweak: 'sound', value: 'default' }, { set_tweak: 'highlight' }];

/** The keywords in these push rules: user-made content rules, which are enabled. The built-in
 *  ones (your username) aren't keywords, and aren't yours to delete. Pure. */
export function readKeywords(rules: IPushRules | undefined): string[] {
  return (rules?.global?.content ?? [])
    .filter((rule: IPushRule) => !rule.default && rule.enabled && typeof rule.pattern === 'string' && rule.pattern.length > 0)
    .map((rule: IPushRule) => rule.pattern as string);
}

/** A keyword as it'll be saved, or why it can't be. Pure. */
export function cleanKeyword(input: string, existing: string[]): { keyword: string } | { error: string } {
  const keyword = input.trim().replace(/\s+/g, ' ');
  if (!keyword) return { error: 'Type a word or phrase.' };
  if (keyword.length > MAX_KEYWORD_LENGTH) return { error: `Keep it under ${MAX_KEYWORD_LENGTH} characters.` };
  if (existing.some((k) => k.toLowerCase() === keyword.toLowerCase())) return { error: 'That one is already on the list.' };
  if (existing.length >= MAX_KEYWORDS) return { error: `You can have up to ${MAX_KEYWORDS}.` };
  return { keyword };
}

export async function addKeyword(mx: MatrixClient, keyword: string): Promise<void> {
  await mx.addPushRule('global', PushRuleKind.ContentSpecific, keyword, {
    pattern: keyword,
    actions: KEYWORD_ACTIONS,
  } as Parameters<MatrixClient['addPushRule']>[3]);
}

export async function removeKeyword(mx: MatrixClient, keyword: string): Promise<void> {
  try {
    await mx.deletePushRule('global', PushRuleKind.ContentSpecific, keyword);
  } catch (err) {
    // Already gone (another device got there first) is the outcome we wanted.
    if ((err as { errcode?: string }).errcode !== 'M_NOT_FOUND') throw err;
  }
}
