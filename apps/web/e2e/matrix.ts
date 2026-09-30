/**
 * Talking to the test homeserver directly, for setting up what a test needs (users, Spaces,
 * rooms) and checking what actually reached the server, without going through the UI.
 */

export const HOMESERVER = process.env.E2E_HOMESERVER ?? 'http://127.0.0.1:6167';
const REGISTRATION_TOKEN = process.env.E2E_REGISTRATION_TOKEN ?? 'e2e-registration-token';

export type TestUser = { userId: string; localpart: string; password: string; accessToken: string };

let counter = 0;

/** A name no other test or earlier run has used, so tests never share state on the server. */
export function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${process.pid}-${counter}`;
}

async function request<T>(method: string, path: string, body?: unknown, accessToken?: string): Promise<T> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data as T;
}

/** Registers a fresh account (the registration token dance, as the app's Register screen does). */
export async function createUser(prefix: string): Promise<TestUser> {
  const localpart = uniqueName(prefix).toLowerCase();
  const password = `pw-${localpart}`;
  const body = { username: localpart, password, initial_device_display_name: 'e2e setup' };
  const first = await fetch(`${HOMESERVER}/_matrix/client/v3/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const challenge = (await first.json()) as { session?: string; access_token?: string; user_id?: string };
  const done =
    first.ok && challenge.access_token
      ? challenge
      : await request<{ access_token: string; user_id: string }>('POST', '/register', {
          ...body,
          auth: { type: 'm.login.registration_token', token: REGISTRATION_TOKEN, session: challenge.session },
        });
  return { userId: done.user_id!, localpart, password, accessToken: done.access_token! };
}

export function api<T = Record<string, unknown>>(user: TestUser, method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(method, path, body, user.accessToken);
}

const enc = encodeURIComponent;

/** A Space with one text channel in it, owned by `owner`, joined by everyone in `members`. */
export async function createSpaceWithChannel(
  owner: TestUser,
  members: TestUser[] = [],
  channelName = 'general'
): Promise<{ spaceId: string; channelId: string; spaceName: string }> {
  const spaceName = uniqueName('Space');
  const { room_id: spaceId } = await api<{ room_id: string }>(owner, 'POST', '/createRoom', {
    name: spaceName,
    preset: 'public_chat',
    creation_content: { type: 'm.space' },
  });
  const { room_id: channelId } = await api<{ room_id: string }>(owner, 'POST', '/createRoom', {
    name: channelName,
    preset: 'public_chat',
    initial_state: [{ type: 'm.space.parent', state_key: spaceId, content: { via: ['localhost'], canonical: true } }],
  });
  await api(owner, 'PUT', `/rooms/${enc(spaceId)}/state/m.space.child/${enc(channelId)}`, { via: ['localhost'] });
  for (const member of members) {
    await api(member, 'POST', `/join/${enc(spaceId)}`, {});
    await api(member, 'POST', `/join/${enc(channelId)}`, {});
  }
  return { spaceId, channelId, spaceName };
}

type RoomEvent = { type: string; sender: string; event_id: string; content: Record<string, any> };

/** The room's latest events, newest first, as `user` sees them. */
export async function latestEvents(user: TestUser, roomId: string, limit = 20): Promise<RoomEvent[]> {
  const { chunk } = await api<{ chunk: RoomEvent[] }>(user, 'GET', `/rooms/${enc(roomId)}/messages?dir=b&limit=${limit}`);
  return chunk;
}

export async function sendText(user: TestUser, roomId: string, body: string): Promise<string> {
  const { event_id } = await api<{ event_id: string }>(user, 'PUT', `/rooms/${enc(roomId)}/send/m.room.message/${enc(uniqueName('txn'))}`, {
    msgtype: 'm.text',
    body,
  });
  return event_id;
}

/** Polls until `check` passes, for things the server does after replying (fan-out, relations). */
export async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let value = await read();
  while (!check(value) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  if (!check(value)) throw new Error(`Timed out waiting; last value: ${JSON.stringify(value).slice(0, 500)}`);
  return value;
}
