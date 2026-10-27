import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import express, { Router, type Request, type Response } from 'express';

/**
 * OBS over WHIP (docs/streaming.md, "OBS"): each person's stream key, kept here, and the WHIP
 * address OBS sends to. Purrlor's address stands in front of LiveKit Ingress: a stream key only
 * gets through while its owner has an OBS stream going, and is swapped for that stream's own
 * Ingress key on the way, so the key in OBS never changes and is never LiveKit's.
 */

/** `pk_` and 32 random bytes. */
export function newStreamKey(random: (n: number) => Buffer = randomBytes): string {
  return `pk_${random(32).toString('base64url')}`;
}

/** Everyone's stream key, in memory and in `/data/obs-keys.json`. */
export class StreamKeys {
  private keys = new Map<string, string>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { keys?: Record<string, unknown> };
      for (const [userId, key] of Object.entries(raw.keys ?? {})) if (typeof key === 'string') this.keys.set(userId, key);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Stream keys not read from ${this.file}`, err);
    }
  }

  /** Their key, made the first time it's asked for. */
  async keyOf(userId: string): Promise<string> {
    return this.keys.get(userId) ?? this.reset(userId);
  }

  /** A new key; the old one stops working at once. */
  async reset(userId: string): Promise<string> {
    const key = newStreamKey();
    this.keys.set(userId, key);
    await this.save();
    return key;
  }

  /** Whose key this is. */
  ownerOf(key: string): string | undefined {
    const given = Buffer.from(key);
    for (const [userId, stored] of this.keys) {
      const expected = Buffer.from(stored);
      if (given.length === expected.length && timingSafeEqual(given, expected)) return userId;
    }
    return undefined;
  }

  private save(): Promise<void> {
    const text = JSON.stringify({ keys: Object.fromEntries(this.keys) }, null, 1);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    return this.writing;
  }
}

export function bearer(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S{1,512})$/i.exec(header.trim());
  return match?.[1];
}

/** An Ingress resource path, `/<ingress key>/<resource>`: which key it is under. */
export function resourceKey(path: string): string | undefined {
  const match = /^\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})$/.exec(path);
  return match?.[1];
}

export type WhipTarget = {
  /** Ingress's WHIP server, inside the stack: `http://ingress:8080`. */
  base: string;
  /** The Ingress key for the OBS stream going now under this Purrlor key; throws a refusal if none. */
  ingressKeyFor(streamKey: string): string;
  refused(err: unknown): { status: number; code: string; message: string } | undefined;
};

const PASSED_BACK = ['content-type', 'etag', 'link', 'accept-patch'];

async function relay(res: Response, target: WhipTarget, method: string, path: string, ingressKey: string, req: Request): Promise<void> {
  const body = Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;
  const answer = await fetch(`${target.base}/w${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ingressKey}`,
      ...(req.headers['content-type'] && { 'Content-Type': req.headers['content-type'] }),
      ...(typeof req.headers['if-match'] === 'string' && { 'If-Match': req.headers['if-match'] }),
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  for (const name of PASSED_BACK) {
    const value = answer.headers.get(name);
    if (value) res.set(name, value);
  }
  const location = answer.headers.get('location');
  // Ingress answers with its own path, `/w/<key>/<resource>`: OBS has to come back through here.
  if (location) res.set('Location', location.replace(/^(?:https?:\/\/[^/]+)?\/w\//, '/api/public/whip/'));
  res.status(answer.status).send(Buffer.from(await answer.arrayBuffer()));
}

/** `/api/public/whip`: where OBS sends its stream. */
export function whipRouter(target: WhipTarget, limited: (req: Request, res: Response) => boolean): Router {
  const router = Router();
  router.use(express.raw({ type: () => true, limit: '256kb' }));

  const failed = (res: Response, err: unknown) => {
    const refusal = target.refused(err);
    if (refusal) return void res.status(refusal.status).json({ error: refusal.message, code: refusal.code });
    console.error('WHIP: Ingress not reached', err);
    res.status(503).json({ error: 'Streaming from OBS isn’t available right now', code: 'unavailable' });
  };

  router.post('/', async (req, res) => {
    if (limited(req, res)) return;
    const key = bearer(req.headers.authorization);
    if (!key) return void res.status(401).json({ error: 'Put your Purrlor stream key in OBS’s Bearer Token', code: 'auth_required' });
    try {
      await relay(res, target, 'POST', '', target.ingressKeyFor(key), req);
    } catch (err) {
      failed(res, err);
    }
  });

  // The session OBS made: ICE updates and hanging up. Its address already carries the Ingress key.
  router.all('*', async (req, res) => {
    if (limited(req, res)) return;
    const ingressKey = resourceKey(req.path);
    if (!ingressKey || !['PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) return void res.status(404).json({ error: 'Not found', code: 'not_found' });
    try {
      await relay(res, target, req.method, req.path, ingressKey, req);
    } catch (err) {
      failed(res, err);
    }
  });

  return router;
}
