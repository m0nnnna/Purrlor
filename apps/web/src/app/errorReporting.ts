import { getRuntimeConfig } from './runtimeConfig';

/**
 * Errors the app hits in this browser, sent to this deployment's own token server, so whoever runs
 * it sees them in `purrlor errors` (services/token-server/src/clientErrors.ts). Nothing goes to
 * anyone else, and nothing about who you are: the error's message and stack, the kind of page it
 * happened on (IDs and names taken out), the build, and nothing more.
 *
 * Only on a deployment (runtime config names a token server), never in development. Anyone can
 * turn it off under Account Settings → Privacy.
 */

const OFF_KEY = 'nekous_error_reports_off';
/** At most this many reports per page load: a loop that throws every frame is one problem. */
const MAX_PER_PAGE = 10;
const VERSION: string | undefined = import.meta.env?.VITE_PURRLOR_VERSION || undefined;

export function errorReportsEnabled(): boolean {
  try {
    return localStorage.getItem(OFF_KEY) !== '1';
  } catch {
    return true;
  }
}

export function setErrorReportsEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(OFF_KEY);
    else localStorage.setItem(OFF_KEY, '1');
  } catch {
    // Private mode and the like: the choice lasts as long as the page.
  }
}

/** Where reports go: the token server's public API, beside the endpoint voice already uses. */
export function reportUrl(tokenEndpoint: string | undefined): string | undefined {
  if (!tokenEndpoint) return undefined;
  try {
    return new URL('/api/public/client-errors', tokenEndpoint).href;
  } catch {
    return undefined;
  }
}

/**
 * The kind of page, not the page: `/@luna/post/abc` → `/:user/post/:id`. Room, event and user IDs,
 * names, and anything long or numeric are replaced; the query and hash are dropped.
 */
export function pagePattern(pathname: string): string {
  const segments = pathname.split('/').map((segment) => {
    if (!segment) return segment;
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Left as it is.
    }
    if (decoded.startsWith('@')) return ':user';
    if (/^[!$#+]/.test(decoded) || decoded.includes(':') || /\d{3,}/.test(decoded) || decoded.length > 24) return ':id';
    return segment;
  });
  return segments.join('/') || '/';
}

/** Noise: a dropped connection, a cancelled request, the browser itself, other people's scripts. */
const IGNORED = [
  /^Script error\.?$/,
  /ResizeObserver loop/,
  /AbortError|The (user|operation) (aborted|was aborted)/,
  /Failed to fetch|NetworkError when attempting|Load failed|The network connection was lost|Network request failed/,
];
const FOREIGN_SCRIPT = /(chrome|moz|safari(-web)?|ms-browser)-extension:\/\//;

type Report = { message: string; stack?: string; where: string; version?: string };

/** What an error becomes, or undefined when it's noise. */
export function describeError(error: unknown, pathname: string): Report | undefined {
  // A DOMException, or an error from another frame, isn't always `instanceof Error`.
  const errorLike =
    !!error && typeof error === 'object' && typeof (error as Error).name === 'string' && typeof (error as Error).message === 'string';
  const err = error instanceof Error || errorLike ? (error as Error) : undefined;
  const message = err ? `${err.name}: ${err.message}` : typeof error === 'string' ? error : (() => {
    try {
      return JSON.stringify(error) ?? String(error);
    } catch {
      return String(error);
    }
  })();
  const stack = err?.stack;
  if (IGNORED.some((pattern) => pattern.test(message))) return undefined;
  if (stack && FOREIGN_SCRIPT.test(stack)) return undefined;
  return {
    message: message.slice(0, 500),
    ...(stack && { stack: stack.slice(0, 4000) }),
    where: pagePattern(pathname),
    ...(VERSION && { version: VERSION }),
  };
}

let sent = 0;
const seen = new Set<string>();

/** Sends one error, unless it's noise, already sent from this page, or reports are off. Never throws. */
export function reportError(error: unknown): void {
  try {
    const url = reportUrl(getRuntimeConfig().tokenEndpoint);
    if (!url || !errorReportsEnabled() || sent >= MAX_PER_PAGE) return;
    const report = describeError(error, location.pathname);
    if (!report) return;
    const key = `${report.message}\n${report.stack?.split('\n')[1] ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    sent += 1;
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      // Still sent if the error is what makes someone close or reload the page.
      keepalive: true,
      credentials: 'omit',
    }).catch(() => undefined);
  } catch {
    // Reporting must never be what breaks.
  }
}

/** Test seam. */
export function resetErrorReporting(): void {
  sent = 0;
  seen.clear();
}

/** Errors nothing else caught: thrown in a handler, or a promise nobody waited for. */
export function installErrorReporting(): void {
  window.addEventListener('error', (event) => {
    // A script from another origin (an extension, an injected ad) has nothing to do with this app.
    if (event.filename && !event.filename.startsWith(location.origin)) return;
    reportError(event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => reportError(event.reason));
}
