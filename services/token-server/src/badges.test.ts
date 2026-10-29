import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { badgeAlias, isBadgeRoomOf, readBadgeRoom } from './badges.js';

const bot = '@bot:a.example';
const ev = (type: string, state_key: string, content: Record<string, unknown>, sender = bot) => ({ type, state_key, content, sender });
const room = [
  ev('m.room.create', '', { type: 'xyz.nekous.badges' }),
  ev('m.room.canonical_alias', '', { alias: badgeAlias('a.example') }),
  ev('xyz.nekous.badge', 'star', { text: 'STAR', color: '#AA66FF' }),
  ev('xyz.nekous.badge', 'bad', { text: 'TOOLONG', color: '#aa66ff' }),
  ev('xyz.nekous.badge_grant', '@luna:a.example', { badges: ['star', 'bad', 'nope'] }),
  ev('xyz.nekous.badge', 'fake', { text: 'FAKE', color: '#ff0000' }, '@luna:a.example'),
  ev('xyz.nekous.badge_grant', '@sol:a.example', { badges: ['fake'] }, '@sol:a.example'),
];

describe('badge room', () => {
  it('is a server\'s only with its type, alias and a creator there', () => {
    assert.equal(isBadgeRoomOf(room, 'a.example'), true);
    assert.equal(isBadgeRoomOf(room, 'b.example'), false);
  });
  it('counts only the creator\'s valid badges and grants', () => {
    const dir = readBadgeRoom(room);
    assert.deepEqual(dir.badges, [{ id: 'star', text: 'STAR', color: '#aa66ff' }]);
    assert.deepEqual(dir.grants, { '@luna:a.example': ['star'] });
  });
});
