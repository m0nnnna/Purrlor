import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withAdminSession } from './adminRoom.js';

const SERVER = 'purr.example';

/** A homeserver with an admin room, where `replies` are what's in the room after a command is sent. */
function fakeHomeserver(replies: (sentId: string) => Record<string, unknown>[]) {
  const seen: { method: string; path: string; body?: unknown }[] = [];
  const fakeFetch = (async (url: string, init: { method: string; body?: string }) => {
    const path = new URL(url).pathname + new URL(url).search;
    seen.push({ method: init.method, path, ...(init.body && { body: JSON.parse(init.body) }) });
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path.endsWith('/login')) return json({ access_token: 'token' });
    if (path.includes('/directory/room/')) return json({ room_id: '!admins:purr.example' });
    if (path.includes('/send/')) return json({ event_id: '$sent' });
    if (path.includes('/messages')) return json({ chunk: replies('$sent'), end: 'end' });
    return json({});
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, seen };
}

const reply = (sender: string, body: string, to = '$sent') => ({
  type: 'm.room.message',
  sender,
  event_id: `$r-${sender}`,
  content: { body, 'm.relates_to': { 'm.in_reply_to': { event_id: to } } },
});

describe('the admin room', () => {
  it("takes the server's own answer to a command", async () => {
    const { fetch } = fakeHomeserver(() => [reply(`@conduit:${SERVER}`, 'Deleted the MXC from our database.')]);
    const answer = await withAdminSession('http://matrix:8008', SERVER, { user: 'admin', password: 'pw' }, (s) => s.command('media delete --mxc mxc://purr.example/a'), {
      fetch,
      pollMs: 1,
    });
    assert.match(answer, /^Deleted the MXC/);
  });

  it("ignores an answer from anyone else in the room, so a file can't be marked deleted by a forged reply", async () => {
    const { fetch } = fakeHomeserver(() => [reply(`@someone:${SERVER}`, 'Deleted the MXC from our database.')]);
    await assert.rejects(
      withAdminSession('http://matrix:8008', SERVER, { user: 'admin', password: 'pw' }, (s) => s.command('media delete --mxc mxc://purr.example/a'), {
        fetch,
        pollMs: 1,
        replyTimeoutMs: 30,
      }),
      /No answer from the homeserver/
    );
  });

  it('refuses a command of more than one line, and always logs out', async () => {
    const { fetch, seen } = fakeHomeserver(() => []);
    await assert.rejects(
      withAdminSession('http://matrix:8008', SERVER, { user: 'admin', password: 'pw' }, (s) => s.command('media delete --mxc mxc://a/b\nusers deactivate @x:y'), { fetch }),
      /one line/
    );
    assert.ok(!seen.some((call) => call.path.includes('/send/')));
    assert.ok(seen.at(-1)?.path.endsWith('/logout'));
  });
});
