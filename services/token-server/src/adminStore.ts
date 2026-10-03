import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isMxc, parseHiddenList, type AdminLists } from './publicWeb.js';
import { auditLine, type AuditEntry, type DeletionEntry, parseDeletions, parseMediaList } from './control.js';
import { parsePeers, type Peer } from './peers.js';

/**
 * What the site's admin has decided, kept as files in the token server's data volume (`/data`),
 * which only root on the host can reach. The control socket (controlServer.ts) changes them; the
 * public routes read them on every request.
 *
 *   hidden-pages.txt     user IDs whose page and public posts are hidden (`purrlor pages hide`)
 *   public-off.txt       user IDs whose page is kept off the public web whatever their switch says
 *   blocked-media.txt    mxc:// URLs the public media route never serves (`purrlor takedown`)
 *   media-deletions.json files queued for deletion from the homeserver, and how that went
 *   peers.json           the Purrlor instances this one federates with (`purrlor peers`)
 *   audit.log            one JSON line per admin action, only ever appended to
 *
 * The text lists are one entry per line, `#` comments allowed, so they can be read (and in a pinch
 * edited) by hand: a change made outside this process is picked up within ten seconds.
 */

const RECHECK_MS = 10_000;

type ListName = keyof AdminLists;

type CachedList = { mtimeMs: number; checkedAt: number; values: Set<string> };

const HEADERS: Record<ListName, string> = {
  hidden: '# Hidden from the public web: their page and their Global posts. One user ID per line.',
  publicOff: "# Pages kept off the public web whatever the owner's switch says. One user ID per line.",
  blockedMedia: '# Never served by the public media route. One mxc:// URL per line.',
};

export class AdminStore {
  readonly files: Record<ListName, string> & { deletions: string; audit: string; peers: string };
  private peerCache: { checkedAt: number; peers: Peer[] } | undefined;
  private cache = new Map<ListName, CachedList>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, hiddenFile = join(dir, 'hidden-pages.txt')) {
    this.files = {
      hidden: hiddenFile,
      publicOff: join(dir, 'public-off.txt'),
      blockedMedia: join(dir, 'blocked-media.txt'),
      deletions: join(dir, 'media-deletions.json'),
      peers: join(dir, 'peers.json'),
      audit: join(dir, 'audit.log'),
    };
  }

  /** Runs changes one at a time, so two commands at once can't lose each other's edits. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private parse(name: ListName, text: string): Set<string> {
    return name === 'blockedMedia' ? parseMediaList(text) : parseHiddenList(text);
  }

  private async read(name: ListName, force = false): Promise<Set<string>> {
    const now = Date.now();
    const cached = this.cache.get(name);
    if (cached && !force && now - cached.checkedAt < RECHECK_MS) return cached.values;
    const file = this.files[name];
    try {
      const { mtimeMs } = await stat(file);
      if (cached && cached.mtimeMs === mtimeMs && !force) {
        cached.checkedAt = now;
        return cached.values;
      }
      const values = this.parse(name, await readFile(file, 'utf8'));
      this.cache.set(name, { mtimeMs, checkedAt: now, values });
      return values;
    } catch {
      const values = new Set<string>();
      this.cache.set(name, { mtimeMs: -1, checkedAt: now, values });
      return values;
    }
  }

  async lists(): Promise<AdminLists> {
    const [hidden, publicOff, blockedMedia] = await Promise.all([this.read('hidden'), this.read('publicOff'), this.read('blockedMedia')]);
    return { hidden, publicOff, blockedMedia };
  }

  /** Adds or removes entries; true for each that changed. Takes effect for the next request. */
  update(name: ListName, values: string[], present: boolean): Promise<boolean[]> {
    return this.serial(async () => {
      const current = new Set(await this.read(name, true));
      const changed = values.map((value) => {
        const had = current.has(value);
        if (present) current.add(value);
        else current.delete(value);
        return had !== present;
      });
      if (changed.some(Boolean)) {
        await writeAtomic(this.files[name], `${HEADERS[name]}\n${[...current].sort().join('\n')}\n`);
        this.cache.delete(name);
        await this.read(name, true);
      }
      return changed;
    });
  }

  async deletions(): Promise<DeletionEntry[]> {
    try {
      return parseDeletions(await readFile(this.files.deletions, 'utf8'));
    } catch {
      return [];
    }
  }

  /** Changes the deletion queue under the same lock as the lists. */
  updateDeletions<T>(fn: (entries: DeletionEntry[]) => { entries: DeletionEntry[]; result: T }): Promise<T> {
    return this.serial(async () => {
      const { entries, result } = fn(await this.deletions());
      await writeAtomic(this.files.deletions, `${JSON.stringify(entries.filter((entry) => isMxc(entry.mxc)), null, 1)}\n`);
      return result;
    });
  }

  /** The approved peers, re-read at most every ten seconds (a hand edit is picked up too). */
  async peers(): Promise<Peer[]> {
    if (this.peerCache && Date.now() - this.peerCache.checkedAt < RECHECK_MS) return this.peerCache.peers;
    let peers: Peer[] = [];
    try {
      peers = parsePeers(await readFile(this.files.peers, 'utf8'));
    } catch {
      // No file yet: no peers.
    }
    this.peerCache = { checkedAt: Date.now(), peers };
    return peers;
  }

  /** Changes the peer list under the same lock as everything else. */
  updatePeers<T>(fn: (peers: Peer[]) => { peers: Peer[]; result: T }): Promise<T> {
    return this.serial(async () => {
      this.peerCache = undefined;
      const { peers, result } = fn(await this.peers());
      await writeAtomic(this.files.peers, `${JSON.stringify(peers, null, 1)}
`);
      this.peerCache = undefined;
      return result;
    });
  }

  /**
   * One line on the end of the audit log. Opened for appending only, never through a symlink, and
   * never rewritten or truncated by anything in this service.
   */
  audit(entry: Omit<AuditEntry, 'at'>): Promise<void> {
    return this.serial(async () => {
      await mkdir(dirname(this.files.audit), { recursive: true, mode: 0o700 });
      const handle = await open(this.files.audit, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.appendFile(auditLine({ at: new Date().toISOString(), ...entry }));
      } finally {
        await handle.close();
      }
    });
  }

  /** The audit log's last `limit` entries, oldest first, as stored. */
  async readAudit(limit: number): Promise<string[]> {
    try {
      const lines = (await readFile(this.files.audit, 'utf8')).split('\n').filter((line) => line.trim());
      return lines.slice(-limit);
    } catch {
      return [];
    }
  }
}

/** Written beside the target then renamed over it, so a reader never sees half a file. */
async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
  await rename(temp, file);
}

const DATA_DIR = process.env.PURRLOR_DATA_DIR ?? '/data';

/** The one store this process uses. */
export const adminStore = new AdminStore(DATA_DIR, process.env.PUBLIC_WEB_HIDDEN_FILE ?? join(DATA_DIR, 'hidden-pages.txt'));
