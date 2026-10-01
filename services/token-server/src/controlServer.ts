import { chmod, lstat, mkdir, readdir, unlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { basename, dirname } from 'node:path';
import express, { type Request, type Response } from 'express';
import { mediaDeleteCommand, withAdminSession, type AdminCredentials, type AdminSession } from './adminRoom.js';
import type { AdminStore } from './adminStore.js';
import {
  cleanActor,
  cleanReason,
  deletionSucceeded,
  parseMediaTarget,
  parseReportNotice,
  queueDeletions,
  terminalSafe,
  type Report,
} from './control.js';
import { isMxc, localUserId, pageMedia, PROFILE_PAGE_EVENT, type RawEvent } from './publicWeb.js';

/**
 * The admin control channel: an HTTP API on a Unix socket, for the `purrlor` command on the host
 * (docs/admin-control.md). It is never on a network: no port, nothing nginx could proxy. The
 * socket's directory and the socket itself belong to root and nobody else may open them, so being
 * able to connect at all is the authentication, the same trust as root on the host already has
 * over the whole install. There's no password or token to leak.
 *
 * Everything that changes something needs a reason, and every action is appended to the audit log
 * with the sudo user who ran it.
 */

export type PageState = {
  /** The person has a profile room this service can read. */
  profileRoom: boolean;
  /** Their own switch: show my page to people who aren't signed in. */
  optedIn: boolean;
  /** They've published a page (as opposed to a plain profile). */
  hasPage: boolean;
  /** The stored page and its event ID, for album takedowns and telling reports apart. */
  content?: Record<string, unknown>;
  pageEventId?: string;
};

export type ControlDeps = {
  store: AdminStore;
  serverName(): Promise<string>;
  /** Where the token server reaches the homeserver (MATRIX_HOMESERVER_URL), for the admin room. */
  homeserverUrl(): string;
  pageState(userId: string): Promise<PageState>;
  /** Every file the public web serves for this person now: posts, page, avatar, banner. */
  publicMediaOf(userId: string): Promise<string[]>;
  profileRoomOwner(roomId: string): Promise<string | undefined>;
  /** Drops the local copy of a file (the media route's cache) at once. */
  forgetCopy(mxc: string): Promise<void>;
  adminSession?: <T>(credentials: AdminCredentials, fn: (session: AdminSession) => Promise<T>) => Promise<T>;
};

class ControlError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** Plain text for the command line, JSON for anything that asks for it. */
function reply(req: Request, res: Response, status: number, message: string, data: Record<string, unknown> = {}): void {
  if ((req.get('accept') ?? '').includes('application/json')) {
    res.status(status).json({ ok: status < 400, message, ...data });
  } else {
    const text = terminalSafe(message);
    res.status(status).type('text/plain').send(text.endsWith('\n') ? text : `${text}\n`);
  }
}

/** A field that may be given once or repeated (`target=a&target=b`). */
function many(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.filter((item): item is string => typeof item === 'string').slice(0, 500);
}

function one(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function needReason(body: Record<string, unknown>): string {
  const reason = cleanReason(body.reason);
  if (!reason) throw new ControlError(400, 'This needs a reason (reason=…): it goes in the audit log.');
  return reason;
}

function credentials(body: Record<string, unknown>): AdminCredentials {
  const user = one(body.adminUser)?.trim();
  const password = one(body.adminPassword);
  if (!user || !password) throw new ControlError(400, "This needs the homeserver admin's account and password (adminUser=…, adminPassword=…).");
  return { user, password };
}

function formatTime(ts: number | string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '?' : date.toISOString().replace('T', ' ').slice(0, 16);
}

/** Art albums and gallery or music blocks on a page matching `name` (an ID or a title, any case). */
export function albumMedia(content: Record<string, unknown> | undefined, name: string): { label: string; urls: string[] }[] {
  const wanted = name.trim().toLowerCase();
  if (!content || !wanted || !Array.isArray(content.blocks)) return [];
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  const matches = (item: Record<string, unknown>) =>
    (typeof item.id === 'string' && item.id.toLowerCase() === wanted) || (typeof item.title === 'string' && item.title.trim().toLowerCase() === wanted);
  const found: { label: string; urls: string[] }[] = [];
  for (const block of content.blocks.filter(isRecord)) {
    if ((block.type === 'art' || block.type === 'gallery') && Array.isArray(block.albums)) {
      for (const album of block.albums.filter(isRecord)) {
        if (!matches(album)) continue;
        const urls = pageMedia({ blocks: [{ type: 'gallery', albums: [album] }] }, { includeMature: true });
        found.push({ label: `album "${String(album.title ?? album.id)}"`, urls: [...urls] });
      }
    } else if ((block.type === 'gallery' || block.type === 'music') && matches(block)) {
      found.push({ label: `${block.type} "${String(block.title ?? block.id)}"`, urls: [...pageMedia({ blocks: [block] }, { includeMature: true })] });
    }
  }
  return found.filter((match) => match.urls.length > 0);
}

export function controlApp(deps: ControlDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.json({ limit: '64kb' }));
  const session = deps.adminSession ?? (async (creds, fn) => withAdminSession(deps.homeserverUrl(), await deps.serverName(), creds, fn));

  type Handler = (req: Request, res: Response, actor: string, body: Record<string, unknown>) => Promise<void>;
  const route = (handler: Handler) => async (req: Request, res: Response) => {
    const body = (typeof req.body === 'object' && req.body) || {};
    const actor = cleanActor(one(body.actor) ?? one(req.query.actor));
    try {
      await handler(req, res, actor, body);
    } catch (err) {
      if (err instanceof ControlError) return reply(req, res, err.status, err.message);
      console.error('Control action failed', err);
      reply(req, res, 500, `That failed: ${(err as Error).message}`);
    }
  };

  const userOf = async (raw: string): Promise<string> => {
    const userId = localUserId(raw, await deps.serverName());
    if (!userId) throw new ControlError(400, `'${raw}' isn't a user name on this server.`);
    return userId;
  };

  app.get('/health', (req, res) => reply(req, res, 200, 'ok'));

  // --- Pages ------------------------------------------------------------------------------------

  app.get(
    '/pages',
    route(async (req, res) => {
      const lists = await deps.store.lists();
      const hidden = [...lists.hidden].sort();
      const publicOff = [...lists.publicOff].sort();
      const text = [
        hidden.length ? `Hidden (page and public posts):\n${hidden.map((id) => `  ${id}`).join('\n')}` : 'No pages are hidden.',
        publicOff.length ? `Public page switched off by an admin:\n${publicOff.map((id) => `  ${id}`).join('\n')}` : 'No public pages are switched off.',
      ].join('\n');
      reply(req, res, 200, text, { hidden, publicOff });
    })
  );

  app.get(
    '/pages/:user',
    route(async (req, res) => {
      const userId = await userOf(req.params.user);
      const [state, lists] = await Promise.all([deps.pageState(userId), deps.store.lists()]);
      const hidden = lists.hidden.has(userId);
      const publicOff = lists.publicOff.has(userId);
      const publicNow = state.profileRoom && state.optedIn && !hidden && !publicOff;
      const lines = [
        userId,
        `  profile room:       ${state.profileRoom ? 'yes' : 'none (they have never posted or built a page)'}`,
        `  page built:         ${state.hasPage ? 'yes' : 'no'}`,
        `  their public switch: ${state.optedIn ? 'on' : 'off'}`,
        `  hidden by an admin: ${hidden ? 'yes' : 'no'}`,
        `  switched off by an admin: ${publicOff ? 'yes' : 'no'}`,
        `  signed-out visitors see the page: ${publicNow ? 'yes' : 'no'}`,
      ];
      reply(req, res, 200, lines.join('\n'), { userId, ...state, content: undefined, hidden, publicOff, public: publicNow });
    })
  );

  const pageAction = (action: 'hide' | 'unhide' | 'public-off' | 'public-on') =>
    route(async (req, res, actor, body) => {
      const userId = await userOf(req.params.user);
      const destructive = action === 'hide' || action === 'public-off';
      const reason = destructive ? needReason(body) : cleanReason(body.reason);
      const list = action === 'hide' || action === 'unhide' ? 'hidden' : 'publicOff';
      const [changed] = await deps.store.update(list, [userId], destructive);
      await deps.store.audit({ actor, action: `pages.${action}`, target: userId, reason, result: changed ? 'ok' : 'no change' });
      const messages = {
        hide: changed ? `Hidden: ${userId}. Their page and public posts are gone for signed-out visitors now.` : `${userId} was already hidden.`,
        unhide: changed ? `Shown again: ${userId}.` : `${userId} wasn't hidden.`,
        'public-off': changed
          ? `${userId}'s page is off the public web now, whatever their own switch says. Their Global posts stay public.`
          : `${userId}'s public page was already switched off.`,
        'public-on': changed ? `${userId}'s own switch decides again whether their page is public.` : `${userId}'s public page wasn't switched off.`,
      };
      reply(req, res, 200, messages[action], { userId, changed });
    });

  app.post('/pages/:user/hide', pageAction('hide'));
  app.post('/pages/:user/unhide', pageAction('unhide'));
  app.post('/pages/:user/public-off', pageAction('public-off'));
  app.post('/pages/:user/public-on', pageAction('public-on'));

  // --- Takedowns --------------------------------------------------------------------------------

  /** Blocks files on the public route now, drops their local copies, and queues their deletion. */
  const takeDown = async (mxcs: string[], actor: string, reason: string, action: string, target: string) => {
    const unique = [...new Set(mxcs.filter(isMxc))];
    const changed = await deps.store.update('blockedMedia', unique, true);
    await Promise.all(unique.map((mxc) => deps.forgetCopy(mxc)));
    const queued = await deps.store.updateDeletions((entries) => queueDeletions(entries, unique, actor, reason, new Date().toISOString()));
    await deps.store.audit({ actor, action, target: `${target}${unique.length ? ` (${unique.join(' ')})` : ''}`, reason, result: 'ok' });
    return { files: unique, newlyBlocked: unique.filter((_, index) => changed[index]), queued };
  };

  const takedownText = (what: string, result: { files: string[]; newlyBlocked: string[]; queued: string[] }) =>
    [
      `Blocked ${result.files.length} file(s) from ${what} on the public web, effective now${result.files.length > result.newlyBlocked.length ? ` (${result.files.length - result.newlyBlocked.length} already were)` : ''}:`,
      ...result.files.map((mxc) => `  ${mxc}`),
      result.queued.length
        ? `${result.queued.length} queued for deletion from the homeserver. To delete them: purrlor takedown delete`
        : 'Nothing new to delete from the homeserver.',
    ].join('\n');

  app.post(
    '/takedown/media',
    route(async (req, res, actor, body) => {
      const targets = many(body.target);
      const reason = needReason(body);
      const mxcs = targets.map(parseMediaTarget);
      const unknown = targets.filter((_, index) => !mxcs[index]);
      if (targets.length === 0 || unknown.length > 0) {
        throw new ControlError(400, `Give each file as an mxc:// URL or its link (target=…).${unknown.length ? ` Not a file: ${unknown.join(', ')}` : ''}`);
      }
      const result = await takeDown(mxcs as string[], actor, reason, 'takedown.media', 'files');
      reply(req, res, 200, takedownText('the list', result), result);
    })
  );

  app.post(
    '/takedown/user/:user',
    route(async (req, res, actor, body) => {
      const userId = await userOf(req.params.user);
      const reason = needReason(body);
      const files = await deps.publicMediaOf(userId);
      if (files.length === 0) {
        await deps.store.audit({ actor, action: 'takedown.user', target: userId, reason, result: 'nothing public' });
        return reply(req, res, 200, `${userId} has no files on the public web right now.`, { files: [] });
      }
      const result = await takeDown(files, actor, reason, 'takedown.user', userId);
      reply(
        req,
        res,
        200,
        `${takedownText(`everything ${userId} has made public`, result)}\nTheir page and posts are still up; to hide those too: purrlor pages hide ${userId}`,
        result
      );
    })
  );

  app.post(
    '/takedown/album/:user',
    route(async (req, res, actor, body) => {
      const userId = await userOf(req.params.user);
      const name = one(body.album) ?? '';
      const reason = needReason(body);
      const state = await deps.pageState(userId);
      const found = albumMedia(state.content, name);
      if (found.length === 0) throw new ControlError(404, `${userId}'s page has no album, gallery or music block called "${cleanReason(name)}".`);
      const label = found.map((match) => match.label).join(', ');
      const result = await takeDown(
        found.flatMap((match) => match.urls),
        actor,
        reason,
        'takedown.album',
        `${userId} ${label}`
      );
      reply(req, res, 200, takedownText(`${userId}'s ${label}`, result), result);
    })
  );

  app.post(
    '/media/unblock',
    route(async (req, res, actor, body) => {
      const targets = many(body.target);
      const parsed = targets.map(parseMediaTarget);
      const unknown = targets.filter((_, index) => !parsed[index]);
      // As with a takedown: one target it can't read and nothing changes, rather than a partial undo.
      if (targets.length === 0 || unknown.length > 0) {
        throw new ControlError(400, `Give each file as an mxc:// URL or its link (target=…).${unknown.length ? ` Not a file: ${unknown.join(', ')}` : ''}`);
      }
      const mxcs = parsed as string[];
      const reason = needReason(body);
      const deleted = new Set((await deps.store.deletions()).filter((entry) => entry.status === 'deleted').map((entry) => entry.mxc));
      const changed = await deps.store.update('blockedMedia', mxcs, false);
      // Nothing to delete any more: out of the queue, unless the homeserver already did it.
      await deps.store.updateDeletions((entries) => ({ entries: entries.filter((entry) => entry.status === 'deleted' || !mxcs.includes(entry.mxc)), result: undefined }));
      await deps.store.audit({ actor, action: 'media.unblock', target: mxcs.join(' '), reason, result: 'ok' });
      const lines = mxcs.map((mxc, index) =>
        deleted.has(mxc) ? `  ${mxc}: unblocked, but it was deleted from the homeserver already` : `  ${mxc}: ${changed[index] ? 'unblocked' : "wasn't blocked"}`
      );
      reply(req, res, 200, ['The public media route serves these again where a public page or post names them:', ...lines].join('\n'), { files: mxcs });
    })
  );

  app.get(
    '/media',
    route(async (req, res) => {
      const [lists, deletions] = await Promise.all([deps.store.lists(), deps.store.deletions()]);
      const blocked = [...lists.blockedMedia].sort();
      const status = new Map(deletions.map((entry) => [entry.mxc, entry]));
      const lines = blocked.length
        ? [
            `Blocked on the public web (${blocked.length}):`,
            ...blocked.map((mxc) => {
              const entry = status.get(mxc);
              const state = !entry ? '' : entry.status === 'deleted' ? '  deleted from the homeserver' : entry.status === 'failed' ? `  deletion failed: ${entry.note ?? '?'}` : '  queued for deletion';
              return `  ${mxc}${state}`;
            }),
          ]
        : ['No files are blocked.'];
      reply(req, res, 200, lines.join('\n'), { blocked, deletions });
    })
  );

  app.post(
    '/deletions/run',
    route(async (req, res, actor, body) => {
      const creds = credentials(body);
      const pending = (await deps.store.deletions()).filter((entry) => entry.status !== 'deleted');
      if (pending.length === 0) return reply(req, res, 200, 'Nothing is waiting to be deleted from the homeserver.', { results: [] });
      const results: { mxc: string; deleted: boolean; note?: string }[] = [];
      try {
        await session(creds, async (admin) => {
          for (const entry of pending) {
            try {
              const answer = await admin.command(mediaDeleteCommand(entry.mxc));
              results.push({ mxc: entry.mxc, deleted: deletionSucceeded(answer), ...(!deletionSucceeded(answer) && { note: cleanReason(answer) }) });
            } catch (err) {
              results.push({ mxc: entry.mxc, deleted: false, note: (err as Error).message });
            }
          }
        });
      } catch (err) {
        await deps.store.audit({ actor, action: 'deletions.run', target: `${pending.length} file(s)`, result: `failed: ${(err as Error).message}` });
        throw new ControlError(502, (err as Error).message);
      }
      const now = new Date().toISOString();
      await deps.store.updateDeletions((entries) => ({
        entries: entries.map((entry) => {
          const result = results.find((item) => item.mxc === entry.mxc);
          if (!result) return entry;
          return { ...entry, status: result.deleted ? 'deleted' : 'failed', doneAt: now, ...(result.note ? { note: result.note } : {}) };
        }),
        result: undefined,
      }));
      for (const result of results) {
        await deps.store.audit({ actor, action: 'deletions.delete', target: result.mxc, result: result.deleted ? 'ok' : `failed: ${result.note ?? '?'}` });
      }
      const failed = results.filter((result) => !result.deleted);
      const text = [
        `Deleted ${results.length - failed.length} of ${results.length} file(s) from the homeserver.`,
        ...failed.map((result) => `  not deleted: ${result.mxc}: ${result.note ?? '?'}`),
        ...(failed.length ? ['They stay blocked on the public web; run it again to retry.'] : []),
      ].join('\n');
      reply(req, res, failed.length ? 207 : 200, text, { results });
    })
  );

  // --- Reports ----------------------------------------------------------------------------------

  app.post(
    '/reports',
    route(async (req, res, actor, body) => {
      const creds = credentials(body);
      const limit = Math.min(Math.max(Number(one(body.limit) ?? body.limit) || 300, 1), 2000);
      const pagesOnly = one(body.only) === 'pages';
      const serverName = await deps.serverName();
      let reports: Report[];
      try {
        reports = await session(creds, async (admin) =>
          (await admin.messages(limit)).map((event) => parseReportNotice(event, serverName)).filter((report): report is Report => !!report)
        );
      } catch (err) {
        await deps.store.audit({ actor, action: 'reports.list', result: `failed: ${(err as Error).message}` });
        throw new ControlError(502, (err as Error).message);
      }
      await deps.store.audit({ actor, action: 'reports.list', result: `ok (${reports.length})` });

      const described = await Promise.all(
        reports.map(async (report) => {
          const owner = report.roomId ? await deps.profileRoomOwner(report.roomId) : undefined;
          const page = owner ? await deps.pageState(owner) : undefined;
          const about = !owner
            ? 'other'
            : report.eventId && report.eventId === page?.pageEventId
              ? 'page'
              : report.eventId
                ? 'profile-post'
                : 'profile';
          return { ...report, about, ...(owner && { owner }) };
        })
      );
      const shown = pagesOnly ? described.filter((report) => report.about !== 'other') : described;
      const what = { page: 'the page of', 'profile-post': 'a post, comment or guestbook entry by or on', profile: 'the profile room of', other: '' };
      const text = shown.length
        ? shown
            .map((report) =>
              [
                `${formatTime(report.ts)}  ${report.about === 'other' ? `${report.kind === 'event' ? 'an' : 'a'} ${report.kind} report (not a profile)` : `${what[report.about as keyof typeof what]} ${report.owner}`}, from ${report.reporter}`,
                `  reason: ${cleanReason(report.reason) || '(none given)'}`,
                ...(report.roomId ? [`  room ${report.roomId}${report.eventId ? `  event ${report.eventId}` : ''}`] : []),
              ].join('\n')
            )
            .join('\n')
        : pagesOnly
          ? 'No reports about profile pages in the admin room.'
          : 'No reports in the admin room.';
      reply(req, res, 200, text, { reports: shown });
    })
  );

  // --- The audit log ----------------------------------------------------------------------------

  app.get(
    '/audit',
    route(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 5000);
      const lines = await deps.store.readAudit(limit);
      const entries = lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, string>];
        } catch {
          return [];
        }
      });
      const text = entries.length
        ? entries
            .map((entry) => `${formatTime(entry.at)}  ${entry.actor}  ${entry.action}${entry.target ? `  ${entry.target}` : ''}  ${entry.result}${entry.reason ? `\n    reason: ${entry.reason}` : ''}`)
            .join('\n')
        : 'The audit log is empty.';
      reply(req, res, 200, text, { entries });
    })
  );

  app.use((req, res) => reply(req, res, 404, `No such control action: ${req.method} ${req.path}`));
  return app;
}

/**
 * Listens on `socketPath`, making sure first that its directory belongs to this process's user
 * (root, in the container) and nobody else can enter it, and that the socket itself is 0600.
 * Refuses to start rather than listen somewhere others could reach.
 */
export async function listenOnControlSocket(socketPath: string, app: express.Express): Promise<Server> {
  const dir = dirname(socketPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${dir} isn't a plain directory`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`${dir} belongs to uid ${info.uid}, not this service's (${process.getuid()})`);
  }
  // The directory is the socket's alone. It comes from the host (PURRLOR_CONTROL_DIR), so a mistake
  // there (`/etc`, `/var`) must not end with this service making a system directory root-only.
  const others = (await readdir(dir)).filter((name) => name !== basename(socketPath));
  if (others.length > 0) throw new Error(`${dir} has other things in it (${others.slice(0, 3).join(', ')}); the control socket needs a directory of its own`);
  await chmod(dir, 0o700);
  if (((await lstat(dir)).mode & 0o077) !== 0) throw new Error(`couldn't make ${dir} private`);

  try {
    const existing = await lstat(socketPath);
    // A socket left by the last run goes; anything else there is a mistake not to paper over.
    if (!existing.isSocket()) throw new Error(`${socketPath} exists and isn't a socket`);
    await unlink(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const server = createServer(app);
  // Deleting a long takedown list waits on the homeserver for each file.
  server.requestTimeout = 15 * 60_000;
  server.headersTimeout = 60_000;
  const previous = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    process.umask(previous);
  }
  await chmod(socketPath, 0o600);
  return server;
}

/** The page facts the control actions need, from a profile room's state. */
export function pageStateFromRoom(state: RawEvent[] | undefined, optedIn: boolean): PageState {
  if (!state) return { profileRoom: false, optedIn: false, hasPage: false };
  const page = state.find((event) => event.type === PROFILE_PAGE_EVENT && event.state_key === '');
  const content = page?.content && typeof page.content.version === 'number' ? page.content : undefined;
  return { profileRoom: true, optedIn, hasPage: !!content, ...(content && { content }), ...(page?.event_id && { pageEventId: page.event_id }) };
}
