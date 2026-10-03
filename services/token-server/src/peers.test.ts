import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminStore } from './adminStore.js';
import { controlApp, type ControlDeps, type PeeringDeps } from './controlServer.js';
import {
  FEDERATION_VERSION,
  cleanInstanceName,
  knownUserId,
  normalizePeerUrl,
  parseInstanceInfo,
  parsePeers,
  parsePeerStatus,
  pickPeerRooms,
  profilePath,
  type Peer,
} from './peers.js';

const LOCAL = 'purr.example';
const PEER = 'cats.example';

describe('normalizePeerUrl', () => {
  it('takes a bare name, or an https address with nothing after the host', () => {
    assert.equal(normalizePeerUrl('cats.example'), 'https://cats.example');
    assert.equal(normalizePeerUrl(' https://Cats.Example/ '), 'https://cats.example');
    assert.equal(normalizePeerUrl('https://cats.example:8443'), 'https://cats.example:8443');
  });

  it('refuses plain http, paths, queries and credentials rather than dropping them', () => {
    for (const bad of ['http://cats.example', 'https://cats.example/app', 'https://cats.example/?x=1', 'https://me:pw@cats.example', 'ftp://cats.example', 'cats example', '']) {
      assert.equal(normalizePeerUrl(bad), undefined, bad);
    }
  });
});

describe('parseInstanceInfo', () => {
  const good = { software: 'purrlor', federation: FEDERATION_VERSION, serverName: PEER, name: 'Cats', url: 'https://app.cats.example' };

  it('accepts a Purrlor instance that federates', () => {
    assert.deepEqual(parseInstanceInfo(good), { ...good, url: 'https://app.cats.example' });
  });

  it('says why anything else is refused', () => {
    assert.match((parseInstanceInfo({ ...good, software: 'synapse' }) as { error: string }).error, /Purrlor instance/);
    assert.match((parseInstanceInfo({ ...good, federation: undefined }) as { error: string }).error, /updating/);
    assert.match((parseInstanceInfo({ ...good, federation: FEDERATION_VERSION + 1 }) as { error: string }).error, /newer/);
    assert.match((parseInstanceInfo({ ...good, serverName: 'not a server' }) as { error: string }).error, /homeserver/);
    assert.match((parseInstanceInfo({ ...good, url: 'http://cats.example' }) as { error: string }).error, /address/);
    assert.ok('error' in parseInstanceInfo('nope'));
  });

  it('falls back to the server name, and strips terminal escapes from the name', () => {
    assert.equal((parseInstanceInfo({ ...good, name: '' }) as { name: string }).name, PEER);
    assert.equal((parseInstanceInfo({ ...good, name: '\u001b]52;c;x\u0007Cats‮' }) as { name: string }).name.includes('\u001b'), false);
    assert.equal(cleanInstanceName('x'.repeat(200), 'f').length, 80);
  });
});

describe('parsePeers', () => {
  it('keeps well-formed peers once each, and drops the rest', () => {
    const text = JSON.stringify([
      { serverName: PEER, url: 'https://cats.example', name: 'Cats', addedAt: '2026-10-03T00:00:00Z', addedBy: 'root' },
      { serverName: PEER, url: 'https://dupe.example' },
      { serverName: 'bad name', url: 'https://x.example' },
      { serverName: 'dogs.example', url: 'http://dogs.example' },
      'junk',
    ]);
    assert.deepEqual(parsePeers(text), [{ serverName: PEER, url: 'https://cats.example', name: 'Cats', addedAt: '2026-10-03T00:00:00Z', addedBy: 'root' }]);
    assert.deepEqual(parsePeers('not json'), []);
    assert.deepEqual(parsePeers('{}'), []);
  });
});

describe('knownUserId and profilePath', () => {
  const peers = new Set([PEER]);

  it('takes this server’s people by name, and a peer’s by full ID', () => {
    assert.equal(knownUserId('luna', LOCAL, peers), `@luna:${LOCAL}`);
    assert.equal(knownUserId('@Luna', LOCAL, peers), `@luna:${LOCAL}`);
    assert.equal(knownUserId(`@mochi:${PEER}`, LOCAL, peers), `@mochi:${PEER}`);
  });

  it('refuses anyone on a server that isn’t a peer', () => {
    assert.equal(knownUserId('@mochi:evil.example', LOCAL, peers), undefined);
    assert.equal(knownUserId('@a/b', LOCAL, peers), undefined);
  });

  it('gives a peer’s person their server in the address', () => {
    assert.equal(profilePath(`@luna:${LOCAL}`, LOCAL), '@luna');
    assert.equal(profilePath(`@mochi:${PEER}`, LOCAL), `@mochi:${PEER}`);
  });
});

describe('pickPeerRooms', () => {
  it('picks public, world-readable profile rooms and Spaces, under the caps', () => {
    const entries = [
      { room_id: '!p1', room_type: 'xyz.nekous.profile', world_readable: true, join_rule: 'public' },
      { room_id: '!p2', room_type: 'xyz.nekous.profile', world_readable: true },
      { room_id: '!p3', room_type: 'xyz.nekous.profile', world_readable: true },
      { room_id: '!hidden', room_type: 'xyz.nekous.profile', world_readable: false },
      { room_id: '!knock', room_type: 'm.space', world_readable: true, join_rule: 'knock' },
      { room_id: '!s1', room_type: 'm.space', world_readable: true, join_rule: 'public' },
      { room_id: '!chat', world_readable: true, join_rule: 'public' },
    ];
    assert.deepEqual(pickPeerRooms(entries, { profiles: 2, spaces: 5 }), { profiles: ['!p1', '!p2'], spaces: ['!s1'] });
  });
});

describe('parsePeerStatus', () => {
  it('keeps only what a peer says about its own people', () => {
    const answer = parsePeerStatus({ hidden: [`@a:${PEER}`, `@b:${LOCAL}`, 7], publicOff: [`@c:${PEER}`] }, PEER);
    assert.deepEqual([...answer!.hidden], [`@a:${PEER}`]);
    assert.deepEqual([...answer!.publicOff], [`@c:${PEER}`]);
    assert.equal(parsePeerStatus({ hidden: 'x' }, PEER), undefined);
  });
});

describe('purrlor peers (the control actions)', () => {
  let dir: string;
  let store: AdminStore;
  let server: Server;
  let base: string;
  const synced: string[] = [];
  const left: string[] = [];
  let instanceAnswer: unknown;

  const peering: PeeringDeps = {
    fetchInstance: async (url) => {
      if (url === 'https://down.example') throw new Error('connect ECONNREFUSED');
      return instanceAnswer;
    },
    sync: async (peer: Peer) => {
      synced.push(peer.serverName);
      return { profiles: 3, spaces: 1, feeds: 4 };
    },
    leave: async (name) => {
      left.push(name);
      return 8;
    },
    status: (name) => (name === PEER ? { profiles: 3, spaces: 1, feeds: 4, lastSync: '2026-10-03T12:00:00Z' } : undefined),
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'purrlor-peers-'));
    store = new AdminStore(dir);
    const deps: ControlDeps = {
      store,
      serverName: async () => LOCAL,
      homeserverUrl: () => 'http://matrix:8008',
      pageState: async () => ({ profileRoom: false, optedIn: false, hasPage: false }),
      publicMediaOf: async () => [],
      profileRoomOwner: async () => undefined,
      forgetCopy: async () => undefined,
      peerServers: async () => new Set((await store.peers()).map((peer) => peer.serverName)),
      peering,
    };
    server = controlApp(deps).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const post = async (path: string, form: Record<string, string>) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', body: new URLSearchParams(form) });
    return { status: res.status, text: await res.text() };
  };

  it('starts with none', async () => {
    const res = await fetch(`${base}/peers`);
    assert.match(await res.text(), /No peers/);
  });

  it('adds a peer after asking it what it is, and audits it', async () => {
    instanceAnswer = { software: 'purrlor', federation: 1, serverName: PEER, name: 'Cats', url: 'https://cats.example' };
    const res = await post('/peers/add', { url: 'cats.example', reason: 'friends', actor: 'mona' });
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /Added Cats \(cats\.example\)/);
    const peers = JSON.parse(await readFile(join(dir, 'peers.json'), 'utf8')) as Peer[];
    assert.equal(peers.length, 1);
    assert.equal(peers[0].addedBy, 'mona');
    assert.deepEqual(synced, [PEER]);
    const audit = await store.readAudit(5);
    assert.match(audit.at(-1)!, /"action":"peers.add"/);
    assert.match(audit.at(-1)!, /"reason":"friends"/);
  });

  it('lists it with what the bot reads there', async () => {
    const text = await (await fetch(`${base}/peers`)).text();
    assert.match(text, /Cats \(cats\.example\) {2}https:\/\/cats\.example/);
    assert.match(text, /reading 3 profile\(s\), 1 Space\(s\), 4 feed\(s\)/);
  });

  it('refuses without a reason, a bad address, itself, something that isn’t Purrlor, and an unreachable one', async () => {
    assert.equal((await post('/peers/add', { url: 'cats.example' })).status, 400);
    assert.equal((await post('/peers/add', { url: 'http://cats.example', reason: 'x' })).status, 400);
    instanceAnswer = { software: 'purrlor', federation: 1, serverName: LOCAL, url: 'https://purr.example' };
    assert.match((await post('/peers/add', { url: 'purr.example', reason: 'x' })).text, /is this instance/);
    instanceAnswer = { hello: 'world' };
    assert.match((await post('/peers/add', { url: 'other.example', reason: 'x' })).text, /doesn't answer as a Purrlor instance/);
    const down = await post('/peers/add', { url: 'down.example', reason: 'x' });
    assert.equal(down.status, 502);
    assert.equal((await store.peers()).length, 1);
  });

  it('lets a peer’s person be hidden here, but nobody else’s', async () => {
    assert.equal((await post(`/pages/@mochi:${PEER}/hide`, { reason: 'spam' })).status, 200);
    assert.ok((await store.lists()).hidden.has(`@mochi:${PEER}`));
    assert.equal((await post('/pages/@x:evil.example/hide', { reason: 'spam' })).status, 400);
  });

  it('removes a peer: the bot leaves its rooms', async () => {
    const res = await post(`/peers/remove/${PEER}`, { reason: 'defederate' });
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /left 8 of its room/);
    assert.deepEqual(left, [PEER]);
    assert.deepEqual(await store.peers(), []);
    assert.equal((await post(`/peers/remove/${PEER}`, { reason: 'again' })).status, 404);
  });

  it('reads a hand-edited peers.json', async () => {
    await writeFile(join(dir, 'peers.json'), JSON.stringify([{ serverName: 'dogs.example', url: 'https://dogs.example', name: 'Dogs' }]));
    const fresh = new AdminStore(dir);
    assert.deepEqual((await fresh.peers()).map((peer) => peer.serverName), ['dogs.example']);
  });
});
