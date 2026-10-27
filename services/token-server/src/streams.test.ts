import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrackSource } from 'livekit-server-sdk';
import {
  admitViewer,
  chatLogText,
  chatMessages,
  chatPowerLevels,
  cleanTitle,
  countViewers,
  downloadAllowed,
  downloadSignature,
  dueAction,
  endedRecord,
  guestIdentity,
  isPublic,
  isStreamId,
  newStreamId,
  openIdFromHeader,
  parseStreamRecord,
  publicStream,
  streamerGrant,
  streamListing,
  streamRoomName,
  streamSettings,
  StreamStore,
  viewerGrant,
  type StreamRecord,
} from './streams.js';

const HOUR = 3_600_000;
const settings = streamSettings({});

function record(over: Partial<StreamRecord> = {}): StreamRecord {
  return {
    id: 'k3J9x_Qm2PzL0aBc',
    owner: '@luna:purr.example',
    title: 'Drawing',
    state: 'live',
    createdAt: 1_000,
    liveAt: 2_000,
    endedAt: null,
    chatRoom: '!chat:purr.example',
    egressId: null,
    replay: null,
    expiresAt: null,
    ...over,
  };
}

describe('streamSettings', () => {
  it('sizes the cap from the uplink: 70% of it over 1.6 Mbps a viewer, half of that for guests', () => {
    assert.deepEqual(
      { cap: settings.viewerCap, guests: settings.guestCap, maxLive: settings.maxLive, enabled: settings.enabled },
      { cap: 43, guests: 21, maxLive: 2, enabled: true }
    );
    const purr = streamSettings({ STREAM_UPLINK_MBPS: '300' });
    assert.equal(purr.viewerCap, 131);
    assert.equal(purr.guestCap, 65);
  });

  it('takes an explicit cap over the sum, and ignores nonsense', () => {
    assert.equal(streamSettings({ STREAM_UPLINK_MBPS: '300', STREAM_VIEWER_CAP: '20' }).viewerCap, 20);
    assert.equal(streamSettings({ STREAM_VIEWER_CAP: 'lots' }).viewerCap, 43);
    assert.equal(streamSettings({ STREAM_UPLINK_MBPS: '-5' }).viewerCap, 43);
    assert.equal(streamSettings({ STREAMING: 'OFF' }).enabled, false);
    assert.equal(streamSettings({ STREAM_REPLAY_HOURS: '24' }).replayMs, 24 * HOUR);
  });
});

describe('ids and titles', () => {
  it('makes 16-character ids from the URL-safe alphabet', () => {
    const id = newStreamId();
    assert.ok(isStreamId(id), id);
    assert.equal(isStreamId('short'), false);
    assert.equal(isStreamId('k3J9x/Qm2PzL0aBc'), false);
    assert.match(guestIdentity(), /^guest-[A-Za-z0-9_-]{16}$/);
    assert.equal(streamRoomName(id), `stream-${id}`);
  });

  it('keeps a title to one line of 1 to 120 characters', () => {
    assert.equal(cleanTitle('  Drawing\n\ta  commission '), 'Drawing a commission');
    assert.equal(cleanTitle('a‮b'), 'a b');
    assert.equal(cleanTitle('   '), undefined);
    assert.equal(cleanTitle(42), undefined);
    assert.equal(cleanTitle('x'.repeat(120)), 'x'.repeat(120));
    assert.equal(cleanTitle('x'.repeat(121)), undefined);
    assert.equal(cleanTitle('🐱'.repeat(120)), '🐱'.repeat(120));
  });
});

describe('grants', () => {
  it('lets the streamer send their screen, its sound and their microphone', () => {
    const grant = streamerGrant('stream-x');
    assert.equal(grant.canPublish, true);
    // Off, LiveKit never connects them (checked against a real server).
    assert.equal(grant.canSubscribe, true);
    assert.equal(grant.canPublishData, false);
    assert.deepEqual(grant.canPublishSources, [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO, TrackSource.MICROPHONE]);
  });

  it('lets a viewer only receive, hidden from everyone else', () => {
    const grant = viewerGrant('stream-x');
    assert.deepEqual(
      { publish: grant.canPublish, data: grant.canPublishData, subscribe: grant.canSubscribe, hidden: grant.hidden, room: grant.room },
      { publish: false, data: false, subscribe: true, hidden: true, room: 'stream-x' }
    );
  });
});

describe('the cap', () => {
  const rooms = [
    {
      owner: '@luna:purr.example',
      people: [
        { identity: '@luna:purr.example', recorder: false },
        { identity: 'EG_abc', recorder: true },
        { identity: '@bob:purr.example', recorder: false },
        { identity: 'guest-aaaaaaaaaaaaaaaa', recorder: false },
      ],
    },
    { owner: '@kit:purr.example', people: [{ identity: '@bob:purr.example', recorder: false }] },
  ];

  it('counts viewers across streams once each, leaving out streamers and recorders', () => {
    assert.deepEqual(countViewers(rooms, [], 0), { total: 2, guests: 1 });
  });

  it('counts tokens given in the last 30 s whose holders have not joined yet', () => {
    const pending = [
      { identity: 'guest-bbbbbbbbbbbbbbbb', at: 100_000 },
      { identity: '@bob:purr.example', at: 100_000 },
      { identity: 'guest-cccccccccccccccc', at: 60_000 },
    ];
    assert.deepEqual(countViewers(rooms, pending, 110_000), { total: 3, guests: 2 });
  });

  it('refuses at the cap, and guests at their half, but never someone already counted', () => {
    const small = { ...settings, viewerCap: 4, guestCap: 2 };
    assert.equal(admitViewer({ total: 3, guests: 1 }, small, true, false), 'ok');
    assert.equal(admitViewer({ total: 3, guests: 2 }, small, true, false), 'guest_full');
    assert.equal(admitViewer({ total: 3, guests: 2 }, small, false, false), 'ok');
    assert.equal(admitViewer({ total: 4, guests: 0 }, small, false, false), 'stream_full');
    assert.equal(admitViewer({ total: 4, guests: 2 }, small, true, true), 'ok');
  });
});

describe('dueAction', () => {
  it('forgets a stream that never went live within 10 minutes', () => {
    const starting = record({ state: 'starting', liveAt: null, createdAt: 0 });
    assert.equal(dueAction(starting, 9 * 60_000, settings, undefined), undefined);
    assert.equal(dueAction(starting, 10 * 60_000, settings, undefined), 'drop');
  });

  it('ends a stream whose streamer has been gone 2 minutes', () => {
    const live = record({ liveAt: 0 });
    assert.equal(dueAction(live, 60_000, settings, undefined), undefined);
    assert.equal(dueAction(live, 120_000, settings, undefined), 'end');
    assert.equal(dueAction(live, 300_000, settings, 250_000), undefined);
    assert.equal(dueAction(live, 400_000, settings, 250_000), 'end');
  });

  it('ends a stream at the longest a stream may run', () => {
    assert.equal(dueAction(record({ liveAt: 0 }), 12 * HOUR, settings, 12 * HOUR), 'end');
  });

  it('expires an ended stream when its replay time is up', () => {
    const ended = endedRecord(record(), 10_000, settings);
    assert.equal(ended.expiresAt, 10_000 + 72 * HOUR);
    assert.equal(dueAction(ended, 10_000 + 72 * HOUR - 1, settings, undefined), undefined);
    assert.equal(dueAction(ended, 10_000 + 72 * HOUR, settings, undefined), 'expire');
  });
});

describe('what the public sees', () => {
  it('shows live streams and unexpired replays, never one still starting', () => {
    assert.equal(isPublic(record(), 5_000), true);
    assert.equal(isPublic(record({ state: 'starting' }), 5_000), false);
    const ended = endedRecord(record(), 10_000, settings);
    assert.equal(isPublic(ended, 10_001), true);
    assert.equal(isPublic(ended, ended.expiresAt!), false);
  });

  it('gives the viewer count only while live, and the replay address once written', () => {
    const live = publicStream(record(), { viewers: 7, hasThumbnail: true });
    assert.equal(live.viewers, 7);
    assert.equal(live.thumbnail, '/api/public/streams/k3J9x_Qm2PzL0aBc/thumbnail');
    const ended = publicStream({ ...endedRecord(record(), 10_000, settings), replay: { bytes: 5, durationMs: 9 } }, { hasThumbnail: false });
    assert.equal('viewers' in ended, false);
    assert.deepEqual(ended.replay, { durationMs: 9, url: '/api/public/streams/k3J9x_Qm2PzL0aBc/replay' });
    assert.equal(ended.thumbnail, null);
    assert.equal('egressId' in ended, false);
  });

  it('lists newest first, for one owner when asked', () => {
    const a = record({ id: 'aaaaaaaaaaaaaaaa', liveAt: 1 });
    const b = record({ id: 'bbbbbbbbbbbbbbbb', liveAt: 3, owner: '@kit:purr.example' });
    const c = record({ id: 'cccccccccccccccc', state: 'starting', liveAt: null, createdAt: 5 });
    assert.deepEqual(
      streamListing([a, b, c], 10).map((r) => r.id),
      ['bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa']
    );
    assert.deepEqual(
      streamListing([a, b, c], 10, '@luna:purr.example').map((r) => r.id),
      ['aaaaaaaaaaaaaaaa']
    );
  });
});

describe('chat', () => {
  it('gives the bot the room and the streamer moderation', () => {
    const levels = chatPowerLevels('@bot:purr.example', '@luna:purr.example') as { users: Record<string, number>; redact: number; events_default: number };
    assert.deepEqual(levels.users, { '@bot:purr.example': 100, '@luna:purr.example': 50 });
    assert.equal(levels.redact, 50);
    assert.equal(levels.events_default, 0);
  });

  it('keeps plain text and emotes, oldest first, and leaves out deleted messages and edits', () => {
    const events = [
      { type: 'm.room.message', event_id: '$2', sender: '@a:x', origin_server_ts: 20, content: { msgtype: 'm.emote', body: 'waves' } },
      { type: 'm.room.message', event_id: '$1', sender: '@b:x', origin_server_ts: 10, content: { msgtype: 'm.text', body: 'hi' } },
      { type: 'm.room.message', event_id: '$3', sender: '@b:x', origin_server_ts: 30, content: {} },
      { type: 'm.room.message', event_id: '$4', sender: '@b:x', origin_server_ts: 40, content: { msgtype: 'm.text', body: '* hey', 'm.relates_to': { rel_type: 'm.replace' } } },
      { type: 'm.room.message', event_id: '$5', sender: '@b:x', origin_server_ts: 50, content: { msgtype: 'm.image', body: 'cat.png' } },
      { type: 'm.reaction', event_id: '$6', sender: '@b:x', origin_server_ts: 60, content: {} },
    ];
    const messages = chatMessages(events);
    assert.deepEqual(
      messages.map((m) => [m.id, m.body]),
      [
        ['$1', 'hi'],
        ['$2', '* waves'],
      ]
    );
    assert.equal(chatLogText(messages), '{"ts":10,"sender":"@b:x","body":"hi"}\n{"ts":20,"sender":"@a:x","body":"* waves"}\n');
    assert.equal(chatLogText([]), '');
  });
});

describe('downloads', () => {
  const secret = Buffer.from('k'.repeat(32));

  it('signs a link to one stream, one file, until a time', () => {
    const sig = downloadSignature(secret, 'k3J9x_Qm2PzL0aBc', 'replay', 2_000);
    assert.equal(downloadAllowed(secret, 'k3J9x_Qm2PzL0aBc', 'replay', '2000', sig, 1_000), true);
    assert.equal(downloadAllowed(secret, 'k3J9x_Qm2PzL0aBc', 'replay', '2000', sig, 2_001), false);
    assert.equal(downloadAllowed(secret, 'k3J9x_Qm2PzL0aBc', 'chat', '2000', sig, 1_000), false);
    assert.equal(downloadAllowed(secret, 'aaaaaaaaaaaaaaaa', 'replay', '2000', sig, 1_000), false);
    assert.equal(downloadAllowed(secret, 'k3J9x_Qm2PzL0aBc', 'replay', '3000', sig, 1_000), false);
    assert.equal(downloadAllowed(secret, 'k3J9x_Qm2PzL0aBc', 'replay', '2000', undefined, 1_000), false);
  });

  it('reads an OpenID authorization header', () => {
    assert.deepEqual(openIdFromHeader('OpenID abc purr.example'), { access_token: 'abc', matrix_server_name: 'purr.example' });
    assert.equal(openIdFromHeader('Bearer abc'), undefined);
    assert.equal(openIdFromHeader(undefined), undefined);
  });
});

describe('StreamStore', () => {
  it('keeps records across a restart and drops ones it cannot read', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'streams-')), 'streams.json');
    const store = new StreamStore(file);
    await store.load();
    await store.put(record());
    await store.put(record({ id: 'bbbbbbbbbbbbbbbb' }));
    await store.remove('bbbbbbbbbbbbbbbb');
    const again = new StreamStore(file);
    await again.load();
    assert.deepEqual(again.all(), [record()]);
    assert.ok((await readFile(file, 'utf8')).includes('k3J9x_Qm2PzL0aBc'));
    assert.equal(parseStreamRecord({ ...record(), id: 'bad' }), undefined);
    assert.equal(parseStreamRecord({ ...record(), state: 'paused' }), undefined);
  });
});
