import { useEffect, useState } from 'react';
import { ClientEvent, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk';
import { useMatrixClient } from './MatrixClientContext';

/**
 * A picture of your own behind the main (global) feed: Settings → Appearance. In your account
 * data, so every device of yours shows it; only you see it. `dim` (0 to 90, percent) lays the
 * app's own background over it so posts stay readable.
 */

export const FEED_BACKGROUND_ACCOUNT_DATA = 'xyz.nekous.feed_background';

export type FeedBackground = { url: string; dim: number };

export const DEFAULT_DIM = 60;

export function parseFeedBackground(raw: unknown): FeedBackground | undefined {
  const value = (raw ?? {}) as Record<string, unknown>;
  if (typeof value.url !== 'string' || !/^mxc:\/\/[^/\s]+\/[^/\s?#]+$/.test(value.url)) return undefined;
  const dim = typeof value.dim === 'number' && Number.isFinite(value.dim) ? Math.min(90, Math.max(0, Math.round(value.dim))) : DEFAULT_DIM;
  return { url: value.url, dim };
}

export function readFeedBackground(mx: MatrixClient): FeedBackground | undefined {
  return parseFeedBackground(mx.getAccountData(FEED_BACKGROUND_ACCOUNT_DATA as never)?.getContent());
}

/** Sets the picture (and dim), or with `undefined` takes it away. */
export async function saveFeedBackground(mx: MatrixClient, background: FeedBackground | undefined): Promise<void> {
  await mx.setAccountData(FEED_BACKGROUND_ACCOUNT_DATA as never, (background ?? {}) as never);
}

/** The picture, kept current as it changes (here or on another device). */
export function useFeedBackground(): FeedBackground | undefined {
  const mx = useMatrixClient();
  const [background, setBackground] = useState(() => readFeedBackground(mx));
  useEffect(() => {
    const onAccountData = (event: MatrixEvent) => {
      if (event.getType() === FEED_BACKGROUND_ACCOUNT_DATA) setBackground(readFeedBackground(mx));
    };
    setBackground(readFeedBackground(mx));
    mx.on(ClientEvent.AccountData, onAccountData);
    return () => {
      mx.removeListener(ClientEvent.AccountData, onAccountData);
    };
  }, [mx]);
  return background;
}
