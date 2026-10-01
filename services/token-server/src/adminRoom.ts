/**
 * The homeserver's admin room, for the two control actions that need the homeserver's admin:
 * deleting a taken-down file (`!admin media delete`) and reading reports (Continuwuity posts each
 * one there). The admin's password comes with the request over the control socket, is used to log
 * in for that one action, and the session is logged out straight after. Nothing here stores it.
 */
import { isMxc } from './publicWeb.js';

export type AdminCredentials = { user: string; password: string };

export type AdminRoomEvent = {
  event_id?: string;
  sender?: string;
  type?: string;
  origin_server_ts?: number;
  content?: Record<string, unknown>;
};

export class AdminRoomError extends Error {}

export type AdminSession = {
  /** Runs `!admin <command>` and returns the server's reply, or throws if none comes. */
  command(command: string): Promise<string>;
  /** The admin room's most recent messages, newest first, up to `limit`. */
  messages(limit: number): Promise<AdminRoomEvent[]>;
};

type Fetch = typeof fetch;

/**
 * Logs in as the admin, finds `#admins:<server>`, runs `fn`, and logs out whatever happens.
 * `homeserverUrl` is the token server's own way to the homeserver (MATRIX_HOMESERVER_URL).
 */
export async function withAdminSession<T>(
  homeserverUrl: string,
  serverName: string,
  credentials: AdminCredentials,
  fn: (session: AdminSession) => Promise<T>,
  options: { fetch?: Fetch; replyTimeoutMs?: number; pollMs?: number } = {}
): Promise<T> {
  const doFetch = options.fetch ?? fetch;
  const base = `${homeserverUrl.replace(/\/+$/, '')}/_matrix/client/v3`;
  let token: string | undefined;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await doFetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new AdminRoomError(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
    return data;
  };

  try {
    const login = await call('POST', '/login', {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: credentials.user },
      password: credentials.password,
      initial_device_display_name: 'purrlor control',
    });
    token = typeof login.access_token === 'string' ? login.access_token : undefined;
    if (!token) throw new AdminRoomError('no access token');
  } catch (err) {
    throw new AdminRoomError(`Couldn't log in as ${credentials.user}: ${(err as Error).message}`);
  }

  try {
    let roomId: string;
    try {
      const found = await call('GET', `/directory/room/${encodeURIComponent(`#admins:${serverName}`)}`);
      roomId = String(found.room_id);
    } catch {
      throw new AdminRoomError(`This homeserver has no #admins:${serverName} room, so this needs doing with its own admin tools.`);
    }
    const room = encodeURIComponent(roomId);
    const replyTimeoutMs = options.replyTimeoutMs ?? 30_000;
    const pollMs = options.pollMs ?? 1000;

    const messages = async (limit: number): Promise<AdminRoomEvent[]> => {
      const events: AdminRoomEvent[] = [];
      let from: string | undefined;
      while (events.length < limit) {
        const page = await call('GET', `/rooms/${room}/messages?dir=b&limit=${Math.min(100, limit - events.length)}${from ? `&from=${encodeURIComponent(from)}` : ''}`);
        const chunk = Array.isArray(page.chunk) ? (page.chunk as AdminRoomEvent[]) : [];
        events.push(...chunk);
        if (chunk.length === 0 || typeof page.end !== 'string' || page.end === from) break;
        from = page.end;
      }
      return events.slice(0, limit);
    };

    const command = async (text: string): Promise<string> => {
      // One line, so a value can never start a second command.
      if (/[\r\n]/.test(text)) throw new AdminRoomError('An admin command is one line.');
      const sent = await call('PUT', `/rooms/${room}/send/m.room.message/purrlor-control-${Date.now()}-${Math.random().toString(36).slice(2)}`, {
        msgtype: 'm.text',
        body: `!admin ${text}`,
      });
      const deadline = Date.now() + replyTimeoutMs;
      while (Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, pollMs));
        const recent = await messages(50);
        const reply = recent.find((event) => {
          const relation = event.content?.['m.relates_to'] as { 'm.in_reply_to'?: { event_id?: string } } | undefined;
          return relation?.['m.in_reply_to']?.event_id === sent.event_id;
        });
        if (reply && typeof reply.content?.body === 'string') return reply.content.body;
      }
      throw new AdminRoomError('No answer from the homeserver. Is that the admin account? Commands from anyone else are ignored.');
    };

    return await fn({ command, messages });
  } finally {
    await call('POST', '/logout', {}).catch(() => undefined);
  }
}

/** The admin-room command that deletes one file: only ever with a checked mxc:// URL in it. */
export function mediaDeleteCommand(mxc: string): string {
  if (!isMxc(mxc)) throw new AdminRoomError(`Not a media URL: ${mxc}`);
  return `media delete --mxc ${mxc}`;
}
