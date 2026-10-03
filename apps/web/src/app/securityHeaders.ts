/**
 * Reads deploy/security-headers.conf (nginx `add_header` lines) into a header map, so `vite preview`
 * (vite.config.ts) and the end-to-end tests serve the app under the same policy production does,
 * and securityHeaders.test.ts can check that policy.
 */
export function parseSecurityHeaders(conf: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of conf.split('\n')) {
    const match = /^\s*add_header\s+([A-Za-z-]+)\s+"([^"]*)"(\s+always)?\s*;\s*$/.exec(line);
    if (match) headers[match[1]] = match[2];
  }
  return headers;
}

/** The directives of a Content-Security-Policy, each with its sources. */
export function parseCsp(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

/**
 * For `vite preview` on this machine: the test homeserver and token server answer over plain HTTP on
 * loopback, which production's https-only connections refuse, and HSTS means nothing over HTTP.
 */
export function previewHeaders(headers: Record<string, string>): Record<string, string> {
  const loopback = ['http://127.0.0.1:*', 'http://localhost:*', 'ws://127.0.0.1:*', 'ws://localhost:*'];
  const csp = parseCsp(headers['Content-Security-Policy'] ?? '');
  for (const directive of ['connect-src', 'img-src', 'media-src']) {
    const sources = csp.get(directive);
    if (sources) csp.set(directive, [...sources, ...loopback]);
  }
  const rest = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'Strict-Transport-Security'));
  return {
    ...rest,
    'Content-Security-Policy': [...csp].map(([name, sources]) => [name, ...sources].join(' ')).join('; '),
  };
}
