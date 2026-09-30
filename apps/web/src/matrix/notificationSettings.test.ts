import { describe, expect, it } from 'vitest';
import type { IPushRule, IPushRules } from 'matrix-js-sdk';
import {
  inheritedLevel,
  managedLevels,
  parseNotificationSettings,
  planRuleChanges,
  readRuleLevel,
  settingsLevel,
  type NotificationSettings,
} from './notificationSettings';

function rules({ override = [], room = [] }: { override?: Partial<IPushRule>[]; room?: Partial<IPushRule>[] }): IPushRules {
  const full = (rule: Partial<IPushRule>): IPushRule => ({ default: false, enabled: true, actions: [], ...rule }) as IPushRule;
  return { global: { override: override.map(full), room: room.map(full), content: [], sender: [], underride: [] } } as IPushRules;
}

const settings = (partial: Partial<NotificationSettings>): NotificationSettings => ({ spaces: {}, rooms: {}, ...partial });

describe('parseNotificationSettings', () => {
  it('keeps only known levels', () => {
    expect(
      parseNotificationSettings({
        spaces: { '!s': 'mentions', '!bad': 'loud' },
        rooms: { '!r': 'nothing', '!n': 3 },
      })
    ).toEqual({ spaces: { '!s': 'mentions' }, rooms: { '!r': 'nothing' } });
  });

  it('treats missing or malformed content as no settings', () => {
    expect(parseNotificationSettings(undefined)).toEqual({ spaces: {}, rooms: {} });
    expect(parseNotificationSettings({ spaces: 'x', rooms: null })).toEqual({ spaces: {}, rooms: {} });
  });
});

describe('levels from settings', () => {
  const children = { '!a': ['!chat', '!shared'], '!b': ['!shared', '!other'] };

  it('gives a channel its Space level, and its own level over that', () => {
    const s = settings({ spaces: { '!a': 'mentions' }, rooms: { '!chat': 'nothing' } });
    expect(settingsLevel(s, children, '!shared')).toBe('mentions');
    expect(settingsLevel(s, children, '!chat')).toBe('nothing');
    expect(settingsLevel(s, children, '!other')).toBeUndefined();
  });

  it('lets the loudest Space win for a channel in several', () => {
    expect(inheritedLevel(settings({ spaces: { '!a': 'nothing', '!b': 'mentions' } }), children, '!shared')).toBe('mentions');
    expect(inheritedLevel(settings({ spaces: { '!a': 'nothing', '!b': 'all' } }), children, '!shared')).toBe('all');
  });

  it('manages every channel of a Space with a level, plus rooms with their own', () => {
    const s = settings({ spaces: { '!a': 'mentions' }, rooms: { '!dm': 'nothing', '!chat': 'all' } });
    expect(managedLevels(s, children)).toEqual({ '!chat': 'all', '!shared': 'mentions', '!dm': 'nothing' });
  });

  it('manages nothing when nothing is set', () => {
    expect(managedLevels(settings({}), children)).toEqual({});
  });
});

describe('readRuleLevel', () => {
  it('reads an override with no actions as Nothing, a silent room rule as Only @mentions', () => {
    expect(readRuleLevel(rules({ override: [{ rule_id: '!r' }] }), '!r')).toBe('nothing');
    expect(readRuleLevel(rules({ room: [{ rule_id: '!r' }] }), '!r')).toBe('mentions');
    expect(readRuleLevel(rules({ room: [{ rule_id: '!r', actions: ['dont_notify' as never] }] }), '!r')).toBe('mentions');
  });

  it('reads a notifying rule, a disabled rule, or none as All messages', () => {
    expect(readRuleLevel(rules({ room: [{ rule_id: '!r', actions: ['notify' as never] }] }), '!r')).toBe('all');
    expect(readRuleLevel(rules({ override: [{ rule_id: '!r', enabled: false }] }), '!r')).toBe('all');
    expect(readRuleLevel(rules({}), '!r')).toBe('all');
    expect(readRuleLevel(undefined, '!r')).toBe('all');
  });
});

describe('planRuleChanges', () => {
  it('adds the one rule each level needs', () => {
    expect(planRuleChanges(rules({}), { '!m': 'mentions', '!n': 'nothing', '!a': 'all' })).toEqual([
      { op: 'add', kind: 'room', roomId: '!m' },
      { op: 'add', kind: 'override', roomId: '!n' },
    ]);
  });

  it('changes nothing when the rules already match', () => {
    const current = rules({ override: [{ rule_id: '!n' }], room: [{ rule_id: '!m' }] });
    expect(planRuleChanges(current, { '!m': 'mentions', '!n': 'nothing', '!a': 'all' })).toEqual([]);
  });

  it('swaps rules when a level changes', () => {
    const current = rules({ override: [{ rule_id: '!r' }] });
    expect(planRuleChanges(current, { '!r': 'mentions' })).toEqual([
      { op: 'delete', kind: 'override', roomId: '!r' },
      { op: 'add', kind: 'room', roomId: '!r' },
    ]);
    expect(planRuleChanges(current, { '!r': 'all' })).toEqual([{ op: 'delete', kind: 'override', roomId: '!r' }]);
  });

  it('replaces a rule of the right kind that does the wrong thing', () => {
    const current = rules({ room: [{ rule_id: '!r', actions: ['notify' as never] }], override: [{ rule_id: '!n', enabled: false }] });
    expect(planRuleChanges(current, { '!r': 'mentions', '!n': 'nothing' })).toEqual([
      { op: 'delete', kind: 'room', roomId: '!r' },
      { op: 'add', kind: 'room', roomId: '!r' },
      { op: 'delete', kind: 'override', roomId: '!n' },
      { op: 'add', kind: 'override', roomId: '!n' },
    ]);
  });

  it('leaves rules for rooms it was not given alone', () => {
    expect(planRuleChanges(rules({ override: [{ rule_id: '!elsewhere' }] }), { '!r': 'all' })).toEqual([]);
  });
});
