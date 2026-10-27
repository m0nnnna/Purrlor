import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IngressClient, RoomServiceClient } from 'livekit-server-sdk';
import type { MatrixClient } from 'matrix-js-sdk';
import { Recorder } from './recordings.js';
import { Streams, type StreamDeps } from './streamRoutes.js';
import { previewIdentity, streamSettings, StreamStore, streamRoomName } from './streams.js';
import { StreamKeys } from './whip.js';

const LUNA = '@luna:purr.example';

/** LiveKit and the Matrix bot as far as Streams uses them, recording what was asked. */
function fakes() {
  const people = new Map<string, { identity: string; kind?: number }[]>();
  const created: { name: string; maxParticipants?: number }[] = [];
  const deleted: string[] = [];
  const rooms = {
    createRoom: async (options: { name: string; maxParticipants?: number }) => void created.push(options),
    listParticipants: async (name: string) => people.get(name) ?? [],
    deleteRoom: async (name: string) => void deleted.push(name),
  } as unknown as RoomServiceClient;
  const stateSent: { type: string; content: Record<string, unknown> }[] = [];
  const moderated: [string, string][] = [];
  const chunk = [{ type: 'm.room.message', event_id: '$1', sender: '@bob:purr.example', origin_server_ts: 5, content: { msgtype: 'm.text', body: 'hi' } }];
  const mx = {
    getUserId: () => '@bot:purr.example',
    createRoom: async () => ({ room_id: '!chat:purr.example' }),
    getStateEvent: async () => ({ users: {}, events_default: 0 }),
    sendStateEvent: async (_room: string, type: string, content: Record<string, unknown>) => void stateSent.push({ type, content }),
    createMessagesRequest: async () => ({ chunk, end: undefined }),
    getJoinedRoomMembers: async () => ({ joined: { '@bot:purr.example': {}, '@bob:purr.example': {} } }),
    kick: async () => undefined,
    leave: async () => undefined,
    getProfileInfo: async () => ({}),
    redactEvent: async (_room: string, eventId: string) => void moderated.push(['redact', eventId]),
    ban: async (_room: string, userId: string) => void moderated.push(['ban', userId]),
    unban: async (_room: string, userId: string) => void moderated.push(['unban', userId]),
  } as unknown as MatrixClient;
  const ingresses: { ingressId: string; roomName?: string; participantIdentity: string }[] = [];
  const ingressesDeleted: string[] = [];
  const ingress = {
    createIngress: async (_input: unknown, opts: { roomName?: string; participantIdentity: string }) => {
      const info = { ingressId: `IN_${ingresses.length}`, streamKey: `ingresskey${ingresses.length}`, ...opts };
      ingresses.push(info);
      return info;
    },
    deleteIngress: async (ingressId: string) => void ingressesDeleted.push(ingressId),
  } as unknown as IngressClient;
  return { people, created, deleted, rooms, mx, stateSent, moderated, ingress, ingresses, ingressesDeleted };
}

async function setup(env: Record<string, string> = {}, hidden: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'streams-'));
  const f = fakes();
  const deps: StreamDeps = {
    settings: streamSettings(env),
    store: new StreamStore(join(dir, 'streams.json')),
    rooms: f.rooms,
    recorder: new Recorder(undefined, dir, '/out'),
    apiKey: 'devkey',
    apiSecret: 'secretsecretsecretsecretsecretsecret',
    livekitUrl: 'wss://livekit.purr.example',
    // The "OpenID token" here is just who it belongs to; 'bad' doesn't check out.
    caller: async (token) => {
      if (token === 'bad') throw new Error('nope');
      return token as string;
    },
    serverName: async () => 'purr.example',
    hidden: async () => new Set(hidden),
    mx: async () => f.mx,
    dataDir: dir,
    obs: { ingress: f.ingress, keys: new StreamKeys(join(dir, 'obs-keys.json')), whipBase: 'http://ingress:8080' },
  };
  return { streams: new Streams(deps), f, dir };
}

const refused = (code: string) => (err: unknown) => (err as { code?: string }).code === code;

describe('going live', () => {
  it('is for this server’s own people, with a title, and not someone hidden', async () => {
    const { streams } = await setup({}, ['@hid:purr.example']);
    await assert.rejects(streams.goLive('@cat:other.example', 'Hi', 'https://purr.example'), refused('not_local'));
    await assert.rejects(streams.goLive('@hid:purr.example', 'Hi', 'https://purr.example'), refused('hidden'));
    await assert.rejects(streams.goLive(LUNA, '   ', 'https://purr.example'), refused('bad_title'));
    await assert.rejects(streams.goLive('bad', 'Hi', 'https://purr.example'), refused('auth_failed'));
    await assert.rejects(streams.goLive(undefined, 'Hi', 'https://purr.example'), refused('auth_required'));
    const { streams: off } = await setup({ STREAMING: 'off' });
    await assert.rejects(off.goLive(LUNA, 'Hi', 'https://purr.example'), refused('streaming_off'));
  });

  it('makes a room sized to the cap and a chat room, and stays private until marked live', async () => {
    const { streams, f } = await setup({ STREAM_UPLINK_MBPS: '300' });
    const { record, token } = await streams.goLive(LUNA, 'Drawing', 'https://purr.example');
    assert.equal(record.state, 'starting');
    assert.equal(record.chatRoom, '!chat:purr.example');
    assert.deepEqual(f.created.map((r) => [r.name, r.maxParticipants]), [[streamRoomName(record.id), 135]]);
    assert.ok(token.split('.').length === 3);
    assert.equal(await streams.publicOne(record.id), undefined);
    await assert.rejects(streams.markLive(record.id, '@bob:purr.example'), refused('not_yours'));
    const live = await streams.markLive(record.id, LUNA);
    assert.equal(live.state, 'live');
    assert.equal((await streams.publicOne(record.id))?.state, 'live');
  });

  it('allows one stream a person, and only so many on the server', async () => {
    const { streams } = await setup({ STREAM_MAX_LIVE: '1' });
    const first = await streams.goLive(LUNA, 'One', 'https://purr.example');
    // Still connecting and trying again: the new one replaces it.
    const again = await streams.goLive(LUNA, 'One again', 'https://purr.example');
    assert.equal(streams.record(first.record.id), undefined);
    await streams.markLive(again.record.id, LUNA);
    await assert.rejects(streams.goLive(LUNA, 'Two', 'https://purr.example'), refused('already_live'));
    await assert.rejects(streams.goLive('@kit:purr.example', 'Mine', 'https://purr.example'), refused('server_busy'));
  });
});

describe('watching', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let id: string;

  beforeEach(async () => {
    ctx = await setup({ STREAM_VIEWER_CAP: '4' });
    id = (await ctx.streams.goLive(LUNA, 'Drawing', 'https://purr.example')).record.id;
  });

  it('gives no token for a stream that isn’t live', async () => {
    await assert.rejects(ctx.streams.viewerToken(id, undefined, undefined), refused('not_found'));
  });

  it('gives each viewing its own identity, guests and signed in, up to the cap', async () => {
    await ctx.streams.markLive(id, LUNA);
    const room = streamRoomName(id);
    ctx.f.people.set(room, [{ identity: LUNA }, { identity: 'EG_rec', kind: 2 }, { identity: 'guest-aaaaaaaaaaaaaaaa' }]);
    const bob = await ctx.streams.viewerToken(id, '@bob:other.example', undefined);
    assert.match(bob.identity, /^@bob:other\.example#[0-9a-f]{8}$/);
    // The guests' half of 4 is 2: one in the room, this one just given.
    const guest = await ctx.streams.viewerToken(id, undefined, undefined);
    assert.match(guest.identity, /^guest-/);
    await assert.rejects(ctx.streams.viewerToken(id, undefined, undefined), refused('guest_full'));
    await ctx.streams.viewerToken(id, '@kit:purr.example', undefined);
    await assert.rejects(ctx.streams.viewerToken(id, '@max:purr.example', undefined), refused('stream_full'));
  });

  it('lets someone still in the room come back as themselves at the cap, and nobody take another’s place', async () => {
    await ctx.streams.markLive(id, LUNA);
    ctx.f.people.set(streamRoomName(id), [{ identity: '@a:x#00000001' }, { identity: '@b:x#00000002' }, { identity: 'guest-aaaaaaaaaaaaaaaa' }, { identity: 'guest-bbbbbbbbbbbbbbbb' }]);
    assert.equal((await ctx.streams.viewerToken(id, '@a:x', '@a:x#00000001')).identity, '@a:x#00000001');
    assert.equal((await ctx.streams.viewerToken(id, undefined, 'guest-aaaaaaaaaaaaaaaa')).identity, 'guest-aaaaaaaaaaaaaaaa');
    await assert.rejects(ctx.streams.viewerToken(id, '@a:x', '@b:x#00000002'), refused('stream_full'));
    await assert.rejects(ctx.streams.viewerToken(id, undefined, '@a:x#00000001'), refused('stream_full'));
  });
});

describe('ending and expiring', () => {
  it('ends for everyone, makes the chat read-only and writes its log', async () => {
    const { streams, f, dir } = await setup();
    const { record } = await streams.goLive(LUNA, 'Drawing', 'https://purr.example');
    await streams.markLive(record.id, LUNA);
    await assert.rejects(streams.stop(record.id, '@bob:purr.example'), refused('not_yours'));
    const ended = await streams.stop(record.id, LUNA);
    assert.equal(ended.state, 'ended');
    assert.ok(ended.expiresAt! > Date.now());
    assert.deepEqual(f.deleted, [streamRoomName(record.id)]);
    // The read-only change and the log are written after the answer.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(f.stateSent.at(-1), { type: 'm.room.power_levels', content: { users: {}, events_default: 50 } });
    assert.equal(await readFile(join(dir, 'streams', record.id, 'chat.jsonl'), 'utf8'), '{"ts":5,"sender":"@bob:purr.example","body":"hi"}\n');
    const links = await streams.downloadLinks(record.id, LUNA);
    assert.equal(links.replay, undefined);
    assert.match(links.chat!, /^\/api\/public\/streams\/[A-Za-z0-9_-]{16}\/files\/chat\?expires=\d+&sig=/);
    await assert.rejects(streams.downloadLinks(record.id, '@bob:purr.example'), refused('not_yours'));
  });

  it('deletes everything when the replay expires, and closes the chat room', async () => {
    const { streams, f } = await setup();
    const { record } = await streams.goLive(LUNA, 'Drawing', 'https://purr.example');
    await streams.markLive(record.id, LUNA);
    const ended = await streams.stop(record.id, LUNA);
    await streams.expire(ended);
    assert.equal(streams.record(record.id), undefined);
    assert.deepEqual(f.stateSent.at(-1), { type: 'm.room.join_rules', content: { join_rule: 'invite' } });
  });

  it('lets the streamer rename a stream, and delete it once it has ended', async () => {
    const { streams } = await setup();
    const { record } = await streams.goLive(LUNA, 'Drawing', 'https://purr.example');
    await streams.markLive(record.id, LUNA);
    await assert.rejects(streams.rename(record.id, '@bob:purr.example', 'Mine now'), refused('not_yours'));
    await assert.rejects(streams.rename(record.id, LUNA, '   '), refused('bad_title'));
    assert.equal((await streams.rename(record.id, LUNA, 'Inking')).title, 'Inking');
    assert.equal(streams.record(record.id)?.title, 'Inking');
    await assert.rejects(streams.remove(record.id, LUNA), refused('not_ended'));
    await streams.stop(record.id, LUNA);
    await assert.rejects(streams.remove(record.id, '@bob:purr.example'), refused('not_yours'));
    await streams.remove(record.id, LUNA);
    assert.equal(streams.record(record.id), undefined);
  });
});

describe('OBS', () => {
  it('gives each person a stream key that only gets through while their OBS stream is going', async () => {
    const { streams, f } = await setup();
    const { url, key } = await streams.obsSettings(LUNA, 'https://purr.example');
    assert.equal(url, 'https://purr.example/api/public/whip');
    assert.equal((await streams.obsSettings(LUNA, 'https://purr.example')).key, key);
    const whip = streams.whipTarget();
    assert.throws(() => whip.ingressKeyFor('pk_nope'), refused('bad_key'));
    assert.throws(() => whip.ingressKeyFor(key), refused('not_live'));

    const { record } = await streams.goLive(LUNA, 'Painting', 'https://purr.example', 'obs');
    assert.equal(record.source, 'obs');
    assert.deepEqual(f.ingresses.map((i) => [i.roomName, i.participantIdentity]), [[streamRoomName(record.id), LUNA]]);
    assert.equal(whip.ingressKeyFor(key), 'ingresskey0');

    // A new key: the old one stops working at once.
    const fresh = (await streams.obsSettings(LUNA, 'https://purr.example', true)).key;
    assert.notEqual(fresh, key);
    assert.throws(() => whip.ingressKeyFor(key), refused('bad_key'));
    assert.equal(whip.ingressKeyFor(fresh), 'ingresskey0');
  });

  it('is live once OBS’s picture arrives, records the camera, and drops the Ingress at the end', async () => {
    const { streams, f } = await setup();
    const { record } = await streams.goLive(LUNA, 'Painting', 'https://purr.example', 'obs');
    assert.equal((await streams.mine(LUNA))?.id, record.id);
    assert.equal(await streams.mine('@bob:purr.example'), null);
    await assert.rejects(streams.markLive(record.id, LUNA), refused('not_receiving'));
    f.people.set(streamRoomName(record.id), [{ identity: LUNA, kind: 1 }, { identity: previewIdentity(LUNA) }]);
    await streams.sweep();
    assert.equal(streams.record(record.id)?.state, 'live');
    await streams.sweep();
    assert.equal(streams.viewersOf(record.id), 0);
    await streams.stop(record.id, LUNA);
    assert.deepEqual(f.ingressesDeleted, ['IN_0']);
    assert.throws(() => streams.whipTarget().ingressKeyFor('anything'), refused('bad_key'));
  });

  it('gives the dashboard a preview token for OBS streams only', async () => {
    const { streams } = await setup();
    const browser = await streams.goLive(LUNA, 'Drawing', 'https://purr.example');
    await assert.rejects(streams.preview(browser.record.id, LUNA), refused('not_obs'));
    const obs = await streams.goLive(LUNA, 'Painting', 'https://purr.example', 'obs');
    await assert.rejects(streams.preview(obs.record.id, '@bob:purr.example'), refused('not_yours'));
    assert.equal((await streams.preview(obs.record.id, LUNA)).split('.').length, 3);
  });
});

describe('moderation', () => {
  it('deletes messages, bans and times out, for the streamer only', async () => {
    const { streams, f } = await setup();
    const { record } = await streams.goLive(LUNA, 'Drawing', 'https://purr.example');
    await streams.markLive(record.id, LUNA);
    const BOB = '@bob:purr.example';
    await assert.rejects(streams.moderate(record.id, BOB, { action: 'ban', user: LUNA }), refused('not_yours'));
    await assert.rejects(streams.moderate(record.id, LUNA, { action: 'ban', user: LUNA }), refused('bad_user'));
    await assert.rejects(streams.moderate(record.id, LUNA, { action: 'timeout', user: BOB, minutes: 0 }), refused('bad_minutes'));
    await streams.moderate(record.id, LUNA, { action: 'delete', event_id: '$1' });
    await streams.moderate(record.id, LUNA, { action: 'ban', user: BOB });
    await streams.moderate(record.id, LUNA, { action: 'unban', user: BOB });
    assert.deepEqual(f.moderated, [['redact', '$1'], ['ban', BOB], ['unban', BOB]]);

    const { timeouts } = await streams.moderate(record.id, LUNA, { action: 'timeout', user: BOB, minutes: 5 });
    assert.ok(timeouts[BOB] > Date.now());
    assert.deepEqual(f.stateSent.at(-1), { type: 'm.room.power_levels', content: { users: { [BOB]: -1 }, events_default: 0 } });
    assert.deepEqual((await streams.moderate(record.id, LUNA, { action: 'untimeout', user: BOB })).timeouts, {});
  });

  it('lifts a timeout once it’s over', async () => {
    const { streams, f } = await setup();
    const { record } = await streams.goLive(LUNA, 'Drawing', 'https://purr.example');
    await streams.markLive(record.id, LUNA);
    f.people.set(streamRoomName(record.id), [{ identity: LUNA }]);
    await streams.moderate(record.id, LUNA, { action: 'timeout', user: '@bob:purr.example', minutes: 1 });
    const stored = streams.record(record.id)!;
    // Over already, as far as the sweep can tell.
    await (streams as unknown as { deps: { store: StreamStore } }).deps.store.put({ ...stored, timeouts: { '@bob:purr.example': Date.now() - 1 } });
    await streams.sweep();
    assert.deepEqual(streams.record(record.id)?.timeouts, {});
  });
});
