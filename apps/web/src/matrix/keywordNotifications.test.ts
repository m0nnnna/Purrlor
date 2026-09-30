import { describe, expect, it, vi } from 'vitest';
import type { IPushRules, MatrixClient } from 'matrix-js-sdk';
import { addKeyword, cleanKeyword, MAX_KEYWORDS, readKeywords, removeKeyword } from './keywordNotifications';

const rules = (content: object[]) => ({ global: { content } }) as unknown as IPushRules;

describe('readKeywords', () => {
  it('lists the enabled content rules that aren’t built in', () => {
    expect(
      readKeywords(
        rules([
          { rule_id: '.m.rule.contains_user_name', default: true, enabled: true, pattern: 'alice', actions: [] },
          { rule_id: 'purrlor', default: false, enabled: true, pattern: 'purrlor', actions: [] },
          { rule_id: 'off', default: false, enabled: false, pattern: 'off', actions: [] },
          { rule_id: 'nopattern', default: false, enabled: true, actions: [] },
        ])
      )
    ).toEqual(['purrlor']);
    expect(readKeywords(undefined)).toEqual([]);
  });
});

describe('cleanKeyword', () => {
  it('trims and tidies, and says why when it can’t', () => {
    expect(cleanKeyword('  movie   night ', [])).toEqual({ keyword: 'movie night' });
    expect(cleanKeyword('   ', [])).toHaveProperty('error');
    expect(cleanKeyword('x'.repeat(51), [])).toHaveProperty('error');
    expect(cleanKeyword('Purrlor', ['purrlor'])).toEqual({ error: 'That one is already on the list.' });
    expect(cleanKeyword('one more', Array.from({ length: MAX_KEYWORDS }, (_, i) => `k${i}`))).toHaveProperty('error');
  });
});

describe('adding and removing', () => {
  it('writes a content rule keyed by the word, with a mention’s actions', async () => {
    const addPushRule = vi.fn(async (..._args: unknown[]) => ({}));
    await addKeyword({ addPushRule } as unknown as MatrixClient, 'purrlor');
    expect(addPushRule).toHaveBeenCalledWith('global', 'content', 'purrlor', {
      pattern: 'purrlor',
      actions: ['notify', { set_tweak: 'sound', value: 'default' }, { set_tweak: 'highlight' }],
    });
  });

  it('treats a rule that’s already gone as removed, and raises anything else', async () => {
    const gone = Object.assign(new Error('nope'), { errcode: 'M_NOT_FOUND' });
    await expect(removeKeyword({ deletePushRule: async () => Promise.reject(gone) } as unknown as MatrixClient, 'x')).resolves.toBeUndefined();
    await expect(removeKeyword({ deletePushRule: async () => Promise.reject(new Error('boom')) } as unknown as MatrixClient, 'x')).rejects.toThrow('boom');
  });
});
