import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AdminSession } from './adminRoom.js';
import { AdminStore } from './adminStore.js';
import { controlApp, listenOnControlSocket, type ControlDeps, type PageState } from './controlServer.js';
import { mayServeMedia, type MediaSource } from './publicWeb.js';

// Unix sockets and file modes: Linux only. These run in CI and in the image's own Node.
const unix = process.platform !== 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const SERVER = 'purr.example';
const LUNA = `@luna:${SERVER}`;
const PAGE = {
  version: 1,
  blocks: [{ id: 'art', type: 'art', albums: [{ id: 'a1', title: 'Fan Art', pieces: [{ url: 'mxc://purr.example/fan1' }] }] }],
};

function call(socketPath: string, method: string, path: string, form?: Record<string, string | string[]>) {
  const body = form
    ? new URLSearchParams(
        Object.entries(form).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((item): [string, string] => [key, item]))
      ).toString()
    : undefined;
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(
      { socketPath, method, path, headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {} },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('the control socket', { skip: !unix && 'Unix sockets only' }, () => {
  let dir: string;
  let socketPath: string;
  let store: AdminStore;
  let server: Server;
  const forgotten: string[] = [];
  const commands: string[] = [];
  let adminMessages: Record<string, unknown>[] = [];

  const deps = (): ControlDeps => ({
    store,
    serverName: async () => SERVER,
    homeserverUrl: () => 'http://matrix:8008',
    pageState: async (userId): Promise<PageState> =>
      userId === LUNA ? { profileRoom: true, optedIn: true, hasPage: true, content: PAGE, pageEventId: '$page' } : { profileRoom: false, optedIn: false, hasPage: false },
    publicMediaOf: async (userId) => (userId === LUNA ? ['mxc://purr.example/avatar', 'mxc://purr.example/post1'] : []),
    profileRoomOwner: async (roomId) => (roomId === '!luna-profile:purr.example' ? LUNA : undefined),
    forgetCopy: async (mxc) => void forgotten.push(mxc),
    adminSession: async (credentials, fn) => {
      if (credentials.password !== 'right') throw new Error(`Couldn't log in as ${credentials.user}: Invalid password`);
      const session: AdminSession = {
        async command(text) {
          commands.push(text);
          return text.includes('fails') ? 'Failed to delete MXC: not found' : 'Deleted the MXC from our database and on our filesystem.';
        },
        async messages() {
          return adminMessages;
        },
      };
      return fn(session);
    },
  });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'purrlor-control-'));
    // Open to all, so it's the control directory's own mode that keeps others out below.
    await chmod(dir, 0o755);
    store = new AdminStore(join(dir, 'data'));
    await store.audit({ actor: 'noc', action: 'test.start', result: 'ok' });
    socketPath = join(dir, 'control', 'purrlor.sock');
    server = await listenOnControlSocket(socketPath, controlApp(deps()));
  });

  after(async () => {
    server?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('is private to its owner: the directory 0700, the socket 0600', async () => {
    assert.equal((await lstat(join(dir, 'control'))).mode & 0o777, 0o700);
    const socket = await lstat(socketPath);
    assert.ok(socket.isSocket());
    assert.equal(socket.mode & 0o777, 0o600);
  });

  it('refuses everyone but root', { skip: !isRoot && 'needs root, to try as someone else' }, () => {
    // A child process dropped to "nobody" can't reach the socket: the directory and socket modes say so.
    const script = `require('net').connect(${JSON.stringify(socketPath)}).on('connect', () => { console.log('connected'); process.exit(0); }).on('error', (e) => { console.log(e.code); process.exit(0); });`;
    const out = execFileSync(process.execPath, ['-e', script], { uid: 65534, gid: 65534, encoding: 'utf8' }).trim();
    assert.equal(out, 'EACCES');
    // And can't read what the admin decided either.
    const read = execFileSync(process.execPath, ['-e', `try { require('fs').readFileSync(${JSON.stringify(store.files.audit)}); } catch (e) { console.log(e.code) }`], {
      uid: 65534,
      gid: 65534,
      encoding: 'utf8',
    }).trim();
    assert.equal(read, 'EACCES');
  });

  it('tightens a directory others could enter', async () => {
    const other = join(dir, 'loose');
    await mkdir(other, { mode: 0o777 });
    await chmod(other, 0o777);
    const s = await listenOnControlSocket(join(other, 'purrlor.sock'), controlApp(deps()));
    s.close();
    assert.equal((await lstat(other)).mode & 0o777, 0o700);
  });

  it("won't listen in a directory that belongs to someone else", { skip: !isRoot && 'needs root, to chown' }, async () => {
    const other = join(dir, 'theirs');
    await mkdir(other, { mode: 0o700 });
    await chown(other, 65534, 65534);
    await assert.rejects(listenOnControlSocket(join(other, 'purrlor.sock'), controlApp(deps())), /belongs to uid 65534/);
  });

  it("won't listen through a symlink, or over a file that isn't a socket", async () => {
    const real = join(dir, 'real');
    await mkdir(real, { mode: 0o700 });
    await symlink(real, join(dir, 'link'));
    await assert.rejects(listenOnControlSocket(join(dir, 'link', 'purrlor.sock'), controlApp(deps())), /isn't a plain directory/);
    await writeFile(join(real, 'purrlor.sock'), 'not a socket');
    await assert.rejects(listenOnControlSocket(join(real, 'purrlor.sock'), controlApp(deps())), /isn't a socket/);
  });

  it('hides a page only with a reason, and logs who did it', async () => {
    const missing = await call(socketPath, 'POST', '/pages/luna/hide', { actor: 'noc' });
    assert.equal(missing.status, 400);
    assert.match(missing.text, /needs a reason/);
    assert.equal((await store.lists()).hidden.has(LUNA), false);

    const done = await call(socketPath, 'POST', '/pages/luna/hide', { actor: 'noc', reason: 'harassment report\n#2' });
    assert.equal(done.status, 200);
    assert.equal((await store.lists()).hidden.has(LUNA), true);
    const [entry] = (await store.readAudit(1)).map((line) => JSON.parse(line));
    assert.deepEqual({ ...entry, at: undefined }, { at: undefined, actor: 'noc', action: 'pages.hide', target: LUNA, reason: 'harassment report #2', result: 'ok' });

    await call(socketPath, 'POST', '/pages/@luna:purr.example/unhide', { actor: 'noc' });
    assert.equal((await store.lists()).hidden.has(LUNA), false);
  });

  it('switches a public page off and on again, separately from hiding', async () => {
    await call(socketPath, 'POST', '/pages/luna/public-off', { actor: 'noc', reason: 'review' });
    const lists = await store.lists();
    assert.equal(lists.publicOff.has(LUNA), true);
    assert.equal(lists.hidden.has(LUNA), false);
    const status = await call(socketPath, 'GET', '/pages/luna');
    assert.match(status.text, /switched off by an admin: yes/);
    assert.match(status.text, /signed-out visitors see the page: no/);
    await call(socketPath, 'POST', '/pages/luna/public-on', { actor: 'noc' });
    assert.equal((await store.lists()).publicOff.has(LUNA), false);
  });

  it("refuses names that aren't users on this server", async () => {
    for (const name of ['@luna:elsewhere.example', 'bad name', '..%2F..%2Fetc']) {
      const res = await call(socketPath, 'POST', `/pages/${encodeURIComponent(name)}/hide`, { reason: 'x' });
      assert.equal(res.status, 400, name);
    }
  });

  it('blocks a taken-down file at once, so it is never served, and queues its deletion', async () => {
    const mxc = 'mxc://purr.example/stolen';
    const sources: MediaSource[] = [{ owner: LUNA, kind: 'post' }];
    assert.equal(mayServeMedia(mxc, sources, await store.lists(), new Set([LUNA])), true);

    const res = await call(socketPath, 'POST', '/takedown/media', {
      actor: 'noc',
      reason: 'DMCA from abuse@',
      target: ['https://purr.example/api/public/media/purr.example/stolen?width=600&height=600'],
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(mayServeMedia(mxc, sources, await store.lists(), new Set([LUNA])), false);
    assert.ok(forgotten.includes(mxc));
    assert.deepEqual(
      (await store.deletions()).map((entry) => [entry.mxc, entry.status]),
      [[mxc, 'queued']]
    );
    assert.match(await readFile(store.files.blockedMedia, 'utf8'), /mxc:\/\/purr\.example\/stolen/);
  });

  it("refuses a takedown with a target it can't read, changing nothing", async () => {
    const before = await readFile(store.files.blockedMedia, 'utf8');
    const res = await call(socketPath, 'POST', '/takedown/media', { reason: 'x', target: ['mxc://purr.example/ok', 'mxc://purr.example/x y'] });
    assert.equal(res.status, 400);
    assert.equal(await readFile(store.files.blockedMedia, 'utf8'), before);
  });

  it("takes down everything one person made public, or one album", async () => {
    const all = await call(socketPath, 'POST', '/takedown/user/luna', { reason: 'repeat infringer' });
    assert.equal(all.status, 200, all.text);
    const blocked = (await store.lists()).blockedMedia;
    assert.ok(blocked.has('mxc://purr.example/avatar') && blocked.has('mxc://purr.example/post1'));

    const album = await call(socketPath, 'POST', '/takedown/album/luna', { reason: 'DMCA', album: 'fan art' });
    assert.equal(album.status, 200, album.text);
    assert.ok((await store.lists()).blockedMedia.has('mxc://purr.example/fan1'));
    const none = await call(socketPath, 'POST', '/takedown/album/luna', { reason: 'DMCA', album: 'nope' });
    assert.equal(none.status, 404);
  });

  it('picks up a block list edited by hand', async () => {
    const text = await readFile(store.files.blockedMedia, 'utf8');
    await writeFile(store.files.blockedMedia, `${text}mxc://purr.example/by-hand\n`);
    // The store re-reads a changed file within ten seconds; a fresh store reads it straight away.
    assert.ok((await new AdminStore(join(dir, 'data')).lists()).blockedMedia.has('mxc://purr.example/by-hand'));
  });

  it("deletes queued files through the admin room, and never logs the admin's password", async () => {
    await call(socketPath, 'POST', '/takedown/media', { reason: 'test', target: 'mxc://purr.example/fails' });
    const wrong = await call(socketPath, 'POST', '/deletions/run', { adminUser: 'admin', adminPassword: 'wrong' });
    assert.equal(wrong.status, 502);
    assert.equal(commands.length, 0);

    const res = await call(socketPath, 'POST', '/deletions/run', { actor: 'noc', adminUser: 'admin', adminPassword: 'right' });
    assert.equal(res.status, 207, res.text);
    assert.ok(commands.every((command) => /^media delete --mxc mxc:\/\/purr\.example\/[A-Za-z0-9_-]+$/.test(command)));
    const deletions = await store.deletions();
    assert.equal(deletions.find((entry) => entry.mxc === 'mxc://purr.example/stolen')?.status, 'deleted');
    assert.equal(deletions.find((entry) => entry.mxc === 'mxc://purr.example/fails')?.status, 'failed');
    // Still blocked: a failed deletion never puts a file back.
    assert.ok((await store.lists()).blockedMedia.has('mxc://purr.example/fails'));

    const log = await readFile(store.files.audit, 'utf8');
    assert.ok(!log.includes('right') && !log.includes('wrong'));
    for (const line of log.trim().split('\n')) JSON.parse(line);
  });

  it('unblocks a file, and takes it out of the deletion queue if it is still there', async () => {
    await call(socketPath, 'POST', '/takedown/media', { reason: 'mistake', target: 'mxc://purr.example/oops' });
    const res = await call(socketPath, 'POST', '/media/unblock', { reason: 'wrong file', target: 'mxc://purr.example/oops' });
    assert.equal(res.status, 200, res.text);
    assert.equal((await store.lists()).blockedMedia.has('mxc://purr.example/oops'), false);
    assert.equal((await store.deletions()).some((entry) => entry.mxc === 'mxc://purr.example/oops'), false);
  });

  it('lists reports from the admin room, saying which are about pages', async () => {
    adminMessages = [
      {
        type: 'm.room.message',
        event_id: '$n1',
        sender: `@conduit:${SERVER}`,
        origin_server_ts: 1790000000000,
        content: {
          body: '@room New event report received from @bob:purr.example:\n\n- Reported Room ID: `!luna-profile:purr.example`\n- Reported Event ID: `$page`\n- Report Reason: stolen art\n',
        },
      },
      {
        type: 'm.room.message',
        event_id: '$n2',
        sender: `@conduit:${SERVER}`,
        origin_server_ts: 1790000001000,
        content: { body: '@room New room report received from @bob:purr.example:\n\n- Reported Room ID: `!chat:purr.example`\n- Report Reason: spam\n' },
      },
      { type: 'm.room.message', event_id: '$n3', sender: `@admin:${SERVER}`, content: { body: '@room New room report received from @x:purr.example:\n' } },
    ];
    const res = await call(socketPath, 'POST', '/reports', { adminUser: 'admin', adminPassword: 'right' });
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /the page of @luna:purr\.example, from @bob:purr\.example/);
    assert.match(res.text, /reason: stolen art/);
    assert.match(res.text, /a room report \(not a profile\)/);
    const pages = await call(socketPath, 'POST', '/reports', { adminUser: 'admin', adminPassword: 'right', only: 'pages' });
    assert.ok(!pages.text.includes('spam'));
  });

  it('shows the audit log', async () => {
    const res = await call(socketPath, 'GET', '/audit?limit=3');
    assert.equal(res.status, 200);
    assert.equal(res.text.trim().split('\n').filter((line) => !line.startsWith('    ')).length, 3);
  });

  it("won't append the audit log through a symlink", async () => {
    const other = new AdminStore(join(dir, 'linked'));
    await mkdir(join(dir, 'linked'), { mode: 0o700 });
    await writeFile(join(dir, 'elsewhere.log'), '');
    await symlink(join(dir, 'elsewhere.log'), other.files.audit);
    await assert.rejects(other.audit({ actor: 'noc', action: 'test', result: 'ok' }));
    assert.equal(await readFile(join(dir, 'elsewhere.log'), 'utf8'), '');
  });
});
