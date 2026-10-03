import { describe, expect, it } from 'vitest';
import conf from '../../deploy/security-headers.conf?raw';
import { parseCsp, parseSecurityHeaders, previewHeaders } from './securityHeaders';

const headers = parseSecurityHeaders(conf);
const csp = parseCsp(headers['Content-Security-Policy'] ?? '');

describe('deploy/security-headers.conf', () => {
  it('sends every header', () => {
    expect(Object.keys(headers).sort()).toEqual([
      'Content-Security-Policy',
      'Permissions-Policy',
      'Referrer-Policy',
      'Strict-Transport-Security',
      'X-Content-Type-Options',
      'X-Frame-Options',
    ]);
  });

  it('runs no inline script and no eval, only WebAssembly', () => {
    const scripts = csp.get('script-src') ?? [];
    expect(scripts).toContain("'self'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(scripts.filter((s) => !s.startsWith("'"))).toEqual(['https://www.youtube.com']);
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
  });

  it('lets no other site frame the app', () => {
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(headers['X-Frame-Options']).toBe('DENY');
  });

  it('keeps fonts and stylesheets to this site and Google Fonts', () => {
    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']);
    expect(csp.get('font-src')).toEqual(["'self'", 'data:', 'https://fonts.gstatic.com']);
  });

  it('has no inline script in index.html to make an exception for', async () => {
    const html = (await import('../../index.html?raw')).default;
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    expect(inline).toEqual([]);
  });
});

describe('previewHeaders', () => {
  it('adds plain-HTTP loopback for the test homeserver, and drops HSTS', () => {
    const preview = previewHeaders(headers);
    const policy = parseCsp(preview['Content-Security-Policy']);
    expect(policy.get('connect-src')).toContain('http://127.0.0.1:*');
    expect(policy.get('script-src')).toEqual(csp.get('script-src'));
    expect(preview['Strict-Transport-Security']).toBeUndefined();
    expect(preview['X-Frame-Options']).toBe('DENY');
  });
});
