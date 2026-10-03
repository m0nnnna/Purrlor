import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';

/**
 * The errors this service has hit, and (in the token server) the ones people's browsers reported,
 * for `purrlor errors` and the alerts (docs/deployment.md, "Errors and metrics").
 *
 * Kept grouped, not as a stream: the same error a thousand times is one entry with a count, so the
 * file stays small (MAX_GROUPS at most) and the list reads as "what's wrong", not as a log to dig
 * through. Saved to ERRORS_FILE (in the data volume, so it survives restarts and is in backups);
 * unset, it's kept in memory only.
 *
 * Shared with the push gateway: services/push-gateway/src/errorLog.ts is a copy of this file
 * (checked by its copies.test.ts), the same way openid.ts is.
 */

export type ErrorSource = 'server' | 'web';

export type ErrorReport = {
  source: ErrorSource;
  message: string;
  stack?: string;
  /** Where it happened: a route on the server, a page in the app (IDs already taken out). */
  where?: string;
  /** The build it came from (a commit), when known. */
  version?: string;
  /** It stopped the service. */
  fatal?: boolean;
};

export type ErrorGroup = Required<Pick<ErrorReport, 'source' | 'message'>> &
  Omit<ErrorReport, 'source' | 'message'> & {
    key: string;
    first: number;
    last: number;
    count: number;
    /** When it happened lately (the newest RECENT_KEPT), for "how many in the last 15 minutes". */
    recent: number[];
  };

export const MAX_GROUPS = 200;
const RECENT_KEPT = 50;
const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
const MAX_FIELD = 200;
/** How long a batch of new errors waits before it's written, so a burst is one write. */
const SAVE_DELAY_MS = 5000;

/**
 * Takes out what mustn't be kept: access tokens, passwords and keys in URLs and headers, Matrix
 * and bearer tokens, and the control characters that could drive a terminal it's printed on.
 */
export function scrub(text: string, max: number): string {
  const cleaned = text
    .replace(/\b(access_token|token|password|secret|key|sig|signature|auth)=[^&\s"']+/gi, '$1=…')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, '$1 …')
    .replace(/\b(syt|syr|mct|mat)_[A-Za-z0-9_-]+/g, '$1_…')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>')
    // Control characters but tab and newline (C0, DEL, C1), and format characters (bidi overrides).
    .replace(/[^\P{Cc}\t\n]|\p{Cf}/gu, '');
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/**
 * What makes two reports the same error: the source, the message with its numbers and IDs taken
 * out, and the first line of the stack that says where, without line and column (which move with
 * every build).
 */
export function fingerprint(report: Pick<ErrorReport, 'source' | 'message' | 'stack'>): string {
  const message = report.message
    .replace(/[!@$#+][^\s:'"]+:[A-Za-z0-9.-]+/g, '<id>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, 'N');
  const frame = (report.stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('at ') || line.includes('@'));
  const place = (frame ?? '').replace(/:\d+(:\d+)?\)?$/, '').replace(/\?[^)\s]*/, '');
  return `${report.source}|${message}|${place}`;
}

function clean(report: ErrorReport): ErrorReport {
  return {
    source: report.source,
    message: scrub(report.message || 'Error', MAX_MESSAGE),
    ...(report.stack && { stack: scrub(report.stack, MAX_STACK) }),
    ...(report.where && { where: scrub(report.where, MAX_FIELD) }),
    ...(report.version && { version: scrub(report.version, 40) }),
    ...(report.fatal && { fatal: true }),
  };
}

function isGroup(value: unknown): value is ErrorGroup {
  const g = value as ErrorGroup;
  return (
    !!g &&
    typeof g.key === 'string' &&
    (g.source === 'server' || g.source === 'web') &&
    typeof g.message === 'string' &&
    typeof g.first === 'number' &&
    typeof g.last === 'number' &&
    typeof g.count === 'number' &&
    Array.isArray(g.recent)
  );
}

export class ErrorLog {
  private groups = new Map<string, ErrorGroup>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saveFailed = false;

  constructor(
    private readonly file?: string,
    /** Called with each error as it's recorded (to count it in the metrics). */
    private readonly onRecord?: (report: ErrorReport) => void
  ) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (Array.isArray(saved)) for (const g of saved) if (isGroup(g)) this.groups.set(g.key, g);
    } catch {
      // No file yet, or one that can't be read: start empty.
    }
  }

  record(report: ErrorReport, now = Date.now()): void {
    const r = clean(report);
    const key = fingerprint(r);
    const existing = this.groups.get(key);
    if (existing) {
      // Newest details win: the latest stack, page and build are the ones worth looking at.
      Object.assign(existing, r, { last: now, count: existing.count + 1 });
      existing.recent = [...existing.recent, now].slice(-RECENT_KEPT);
      this.groups.delete(key);
      this.groups.set(key, existing);
    } else {
      this.groups.set(key, { ...r, key, first: now, last: now, count: 1, recent: [now] });
      if (this.groups.size > MAX_GROUPS) {
        // Map order is by when a group was last seen (re-inserted above), so the first is the stalest.
        this.groups.delete(this.groups.keys().next().value!);
      }
    }
    this.onRecord?.(r);
    if (r.fatal) this.saveNow();
    else this.saveSoon();
  }

  /** Newest first. */
  list(source?: ErrorSource): ErrorGroup[] {
    return [...this.groups.values()].filter((g) => !source || g.source === source).sort((a, b) => b.last - a.last);
  }

  /** How many errors (not kinds) of each sort since `since`, and how many of them stopped the service. */
  countsSince(since: number): { server: number; web: number; fatal: number } {
    const counts = { server: 0, web: 0, fatal: 0 };
    for (const g of this.groups.values()) {
      const n = g.recent.filter((at) => at >= since).length;
      counts[g.source] += n;
      if (g.fatal) counts.fatal += n;
    }
    return counts;
  }

  clear(): void {
    this.groups.clear();
    this.saveNow();
  }

  private saveSoon(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      const tmp = `${this.file}.tmp`;
      writeFile(tmp, JSON.stringify(this.list()))
        .then(() => rename(tmp, this.file!))
        .then(() => (this.saveFailed = false), (err: Error) => this.warnSaveFailed(err));
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  /** Right away, and synchronously: for a crash, where nothing after this line will run. */
  private saveNow(): void {
    if (!this.file) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.list()));
      renameSync(tmp, this.file);
      this.saveFailed = false;
    } catch (err) {
      this.warnSaveFailed(err as Error);
    }
  }

  // console.warn, not console.error: errors are what's being recorded, and that would loop.
  private warnSaveFailed(err: Error): void {
    if (this.saveFailed) return;
    this.saveFailed = true;
    console.warn(`Couldn't save the error log to ${this.file}: ${err.message}`);
  }
}

/** "5 min ago", "3 h ago", "2 days ago". */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

const LABEL: Record<ErrorSource, string> = { server: 'here', web: "in people's browsers" };

/** What `purrlor errors` prints. `stackLines` 0 leaves stacks out. */
export function describeErrors(groups: ErrorGroup[], service: string, { stackLines = 6, now = Date.now() } = {}): string {
  if (groups.length === 0) return `${service}: no errors recorded.\n`;
  const total = groups.reduce((n, g) => n + g.count, 0);
  const kinds = groups.length === 1 ? '1 kind of error' : `${groups.length} kinds of error`;
  const lines = [`${service}: ${kinds}, ${total} in all. Newest first:`];
  for (const g of groups) {
    lines.push('');
    lines.push(`${g.fatal ? '[crashed] ' : ''}${g.message}`);
    const details = [
      g.count === 1 ? 'once' : `${g.count} times`,
      `last ${ago(g.last, now)}`,
      ...(g.count > 1 ? [`first ${ago(g.first, now)}`] : []),
      LABEL[g.source],
      ...(g.where ? [g.where] : []),
      ...(g.version ? [`version ${g.version}`] : []),
    ];
    lines.push(`  ${details.join(' · ')}`);
    if (stackLines > 0 && g.stack) {
      const frames = g.stack
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && line !== g.message && !line.endsWith(g.message));
      for (const frame of frames.slice(0, stackLines)) lines.push(`    ${frame}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** console.error's arguments as one error: the text of them all, and the first stack among them. */
export function fromConsoleArgs(args: unknown[]): Pick<ErrorReport, 'message' | 'stack'> {
  const parts: string[] = [];
  let stack: string | undefined;
  for (const arg of args) {
    if (arg instanceof Error) {
      parts.push(`${arg.name}: ${arg.message}`);
      stack ??= arg.stack;
    } else if (typeof arg === 'string') {
      parts.push(arg);
    } else {
      try {
        parts.push(JSON.stringify(arg) ?? String(arg));
      } catch {
        parts.push(String(arg));
      }
    }
  }
  return { message: parts.join(' ').trim() || 'Error', ...(stack && { stack }) };
}

/**
 * Records everything this process reports as an error: each console.error (every caught failure in
 * these services is logged that way), and a crash, which is saved before the process ends. It
 * changes nothing else: the message still goes to the log, and a crash still ends the process.
 */
export function captureProcessErrors(log: ErrorLog, version?: string): void {
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(...args);
    try {
      log.record({ source: 'server', ...fromConsoleArgs(args), version });
    } catch {
      // Recording must never be the thing that breaks.
    }
  };
  // The monitor runs before Node's own handling, which stays as it was (print and exit).
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    const error = err instanceof Error ? err : new Error(String(err));
    log.record({
      source: 'server',
      message: `${origin === 'unhandledRejection' ? 'Unhandled rejection' : 'Crash'}: ${error.name}: ${error.message}`,
      stack: error.stack,
      version,
      fatal: true,
    });
  });
}
