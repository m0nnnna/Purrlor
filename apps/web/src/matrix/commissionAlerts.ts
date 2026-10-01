import type { MatrixClient } from 'matrix-js-sdk';
import { readFreshAccountData } from './freshAccountData';

/**
 * "Tell me when this artist's commissions open", per artist, kept in your own account data so
 * every device knows. It's worked out where you are: your client sees the artist's
 * `xyz.nekous.commission_status` change in their profile room (which you're in once you follow
 * them) and tells you (features/profilePage/CommissionAlerts.tsx). Nothing is sent to a server, so
 * it comes while a tab is open, not as a push.
 */
export const COMMISSION_ALERTS_ACCOUNT_DATA = 'xyz.nekous.commission_alerts';

export function parseAlertList(content: unknown): string[] {
  const users = (content as { users?: unknown } | undefined)?.users;
  return Array.isArray(users) ? users.filter((user): user is string => typeof user === 'string' && !!user).slice(0, 500) : [];
}

export function readAlertList(mx: MatrixClient): string[] {
  return parseAlertList(mx.getAccountData(COMMISSION_ALERTS_ACCOUNT_DATA as any)?.getContent());
}

/** Pure, so it's tested without a client. */
export function withAlert(list: string[], artistId: string, on: boolean): string[] {
  const without = list.filter((user) => user !== artistId);
  return on ? [...without, artistId] : without;
}

export async function setCommissionAlert(mx: MatrixClient, artistId: string, on: boolean): Promise<void> {
  const fresh = parseAlertList(await readFreshAccountData(mx, COMMISSION_ALERTS_ACCOUNT_DATA));
  await mx.setAccountData(COMMISSION_ALERTS_ACCOUNT_DATA as any, { users: withAlert(fresh, artistId, on) } as any);
}

/**
 * Whether a status change should tell you: it's an artist you asked about, it went to open from
 * something else, it just happened (a state event re-delivered at start-up isn't news), and it
 * isn't you.
 */
export function shouldAlertOpening(
  change: { sender: string; status: string | undefined; previousStatus: string | undefined; ts: number },
  alerts: string[],
  myUserId: string,
  now = Date.now()
): boolean {
  return (
    change.status === 'open' &&
    change.previousStatus !== undefined &&
    change.previousStatus !== 'open' &&
    change.sender !== myUserId &&
    alerts.includes(change.sender) &&
    now - change.ts < 2 * 60 * 1000
  );
}
