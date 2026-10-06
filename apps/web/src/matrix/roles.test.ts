import { describe, expect, it } from 'vitest';
import {
  ROLE_LEVELS,
  capabilityLevel,
  handleFor,
  lowestRoleLevel,
  parseCustomRoles,
  roleFor,
  roleMentionGroups,
  toStoredRoles,
  withCapability,
} from './roles';

describe('roleFor', () => {
  it('maps power levels to the highest role they reach', () => {
    expect(roleFor(100).id).toBe('admin');
    expect(roleFor(150).id).toBe('admin');
    expect(roleFor(50).id).toBe('moderator');
    expect(roleFor(99).id).toBe('moderator');
    expect(roleFor(0).id).toBe('member');
    expect(roleFor(10).id).toBe('member');
  });

  it('treats negative power levels as members', () => {
    expect(roleFor(-5).id).toBe('member');
  });
});

describe('handleFor', () => {
  it('strips the server name from a Matrix ID', () => {
    expect(handleFor('@neko:example.org')).toBe('@neko');
  });

  it('leaves an ID without a server part alone', () => {
    expect(handleFor('@neko')).toBe('@neko');
  });
});

describe('custom roles', () => {
  const content = {
    roles: [
      { id: 'helper', name: 'Helper', level: 25, color: '#FF8800' },
      { id: 'senior', name: '  Senior mod ', level: 75 },
      { id: 'clash', name: 'Also 25', level: 25 },
      { id: 'mod', name: 'Not Moderator', level: 50 },
      { id: 'big', name: 'Too high', level: 100 },
      { id: 'frac', name: 'Half', level: 12.5 },
      { name: 'No id', level: 30 },
    ],
  };

  it('keeps each valid role at a level of its own, and nothing that would clash with a built-in', () => {
    expect(parseCustomRoles(content).map((r) => [r.id, r.label, r.value, r.color])).toEqual([
      ['custom:helper', 'Helper', 25, '#ff8800'],
      ['custom:senior', 'Senior mod', 75, undefined],
    ]);
  });

  it('places people by the highest role at or below their level', () => {
    const roles = [...ROLE_LEVELS, ...parseCustomRoles(content)];
    expect(roleFor(30, roles).label).toBe('Helper');
    expect(roleFor(80, roles).label).toBe('Senior mod');
    expect(roleFor(60, roles).label).toBe('Moderator');
    expect(roleFor(10, roles).label).toBe('Member');
    expect(lowestRoleLevel(roles)).toBe(25);
    expect(lowestRoleLevel(ROLE_LEVELS)).toBe(50);
  });

  it('saves back what it read', () => {
    const roles = parseCustomRoles(content);
    expect(parseCustomRoles(toStoredRoles(roles))).toEqual(roles);
  });
});

describe('capabilities', () => {
  it('reads Matrix’s thresholds with the spec’s defaults, and sets one without touching the rest', () => {
    expect(capabilityLevel({}, 'redact')).toBe(50);
    expect(capabilityLevel({}, 'invite')).toBe(0);
    expect(capabilityLevel({ state_default: 50 }, 'pin')).toBe(50);
    const next = withCapability({ events: { 'm.room.name': 50 }, kick: 50 }, 'pin', 25);
    expect(next).toEqual({ events: { 'm.room.name': 50, 'm.room.pinned_events': 25 }, kick: 50 });
    expect((withCapability(next, 'redact', 25) as { redact?: number }).redact).toBe(25);
  });
});

describe('roleMentionGroups', () => {
  const roles = [...ROLE_LEVELS, { id: 'custom:h', label: 'Helper', pluralLabel: 'Helper', value: 25, custom: true }].sort(
    (a, b) => b.value - a.value
  );
  const members = [
    { userId: '@admin:x', powerLevel: 100 },
    { userId: '@mod:x', powerLevel: 50 },
    { userId: '@senior:x', powerLevel: 60 },
    { userId: '@helper:x', powerLevel: 25 },
    { userId: '@cat:x', powerLevel: 0 },
  ];

  it('groups people by the role they hold, leaving out Member and empty roles', () => {
    expect(roleMentionGroups(members, roles)).toEqual([
      { id: 'admin', names: ['Admins', 'Admin'], userIds: ['@admin:x'] },
      { id: 'moderator', names: ['Moderators', 'Moderator'], userIds: ['@mod:x', '@senior:x'] },
      { id: 'custom:h', names: ['Helper'], userIds: ['@helper:x'] },
    ]);
    expect(roleMentionGroups([{ userId: '@cat:x', powerLevel: 0 }], roles)).toEqual([]);
  });
});
