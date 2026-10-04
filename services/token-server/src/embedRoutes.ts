import { Router } from 'express';
import { urlProblem } from './embedGuard.js';
import { embedCache, embedFiles } from './embedResolve.js';
import { validateOpenIdToken } from './openid.js';
import { serverNameOf } from './publicWeb.js';
import { serverName } from './publicWebRoutes.js';
import { RateLimiter } from './webhooks.js';

/** Links resolved per account: a burst of 30, then 60 a minute (docs/embeds.md). */
const resolveLimiter = new RateLimiter(30, 60);

/**
 * `/api/public/embeds`: resolving links for this server's own people (docs/embeds.md, "Resolving:
 * the token server"). Mounted ahead of the public web's router in server.ts.
 */
export function embedsRouter(): Router {
  const router = Router();

  router.post('/resolve', async (req, res) => {
    const link = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    let caller: string;
    try {
      const ownServer = await serverName();
      caller = await validateOpenIdToken(req.body?.openid_token, { serverName: ownServer, baseUrl: process.env.MATRIX_HOMESERVER_URL ?? '' });
      if (serverNameOf(caller) !== ownServer) return void res.status(403).json({ error: 'Not an account on this server', code: 'not_local' });
    } catch {
      return void res.status(401).json({ error: 'Authentication failed' });
    }
    if (!link || link.length > 2048) return void res.status(400).json({ error: 'url is required', code: 'bad_request' });
    if (!resolveLimiter.take(caller)) return void res.status(429).json({ error: 'Too many links; slow down' });
    // A link the guard won't fetch is simply one with no embed.
    if (urlProblem(link)) return void res.status(204).end();
    const resolved = await embedCache.get(link);
    if (!resolved) return void res.status(204).end();
    res.set('Cache-Control', 'no-store').json(resolved);
  });

  router.get('/files/:id', (req, res) => {
    const file = embedFiles.get(req.params.id);
    if (!file) return void res.status(404).json({ error: 'Gone; resolve the link again', code: 'not_found' });
    // Bytes from anywhere, on the app's own origin: never run, never sniffed, never shown as a page.
    res
      .set('Content-Type', file.mimetype)
      .set('Content-Disposition', 'attachment')
      .set('X-Content-Type-Options', 'nosniff')
      .set('Content-Security-Policy', "default-src 'none'; sandbox")
      .set('Cache-Control', 'private, max-age=900')
      .send(file.bytes);
  });

  return router;
}
