import { isDemoMode } from '../demo/demoMode';

/**
 * The public web's answers (services/token-server/src/publicWebRoutes.ts, docs/public-web.md),
 * served under the app's own address at /api/public by the deployment's nginx.
 */
const PUBLIC_API = '/api/public';

/**
 * Whether an admin hid this person's page (`purrlor pages hide`). A hidden page isn't drawn in the
 * app either, except for its owner, who's told. Unknown (no public web on this deployment, or it
 * didn't answer) counts as not hidden: hiding is a deployment's call, and without one there's
 * nothing to honour.
 */
export async function fetchPageHidden(userId: string): Promise<boolean> {
  if (isDemoMode()) return false;
  try {
    const response = await fetch(`${PUBLIC_API}/status/${encodeURIComponent(userId)}`);
    if (!response.ok) return false;
    const body = (await response.json()) as { hidden?: unknown };
    return body.hidden === true;
  } catch {
    return false;
  }
}
