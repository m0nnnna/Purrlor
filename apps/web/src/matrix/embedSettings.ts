import { useContext, useEffect, useState } from 'react';
import { ClientEvent, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk';
import { MatrixClientContext } from './MatrixClientContext';

/**
 * A person's link embed settings (docs/embeds.md), in their account data so every device of
 * theirs agrees: which embeds to draw (Settings → Appearance), and whether their own messages in
 * encrypted chats may have any (Settings → Privacy; off unless they say so).
 */

export const EMBED_SETTINGS_ACCOUNT_DATA = 'xyz.nekous.embed_settings';

/** `all`: every embed. `no-players`: players are cards that open the site. `none`: plain links. */
export type EmbedShow = 'all' | 'no-players' | 'none';
export type EmbedSettings = { show: EmbedShow; encrypted: boolean };

export const DEFAULT_EMBED_SETTINGS: EmbedSettings = { show: 'all', encrypted: false };

export function parseEmbedSettings(raw: unknown): EmbedSettings {
  const value = (raw ?? {}) as Record<string, unknown>;
  const show = value.show === 'no-players' || value.show === 'none' ? value.show : 'all';
  return { show, encrypted: value.encrypted === true };
}

export function readEmbedSettings(mx: MatrixClient): EmbedSettings {
  return parseEmbedSettings(mx.getAccountData(EMBED_SETTINGS_ACCOUNT_DATA as never)?.getContent());
}

export async function saveEmbedSettings(mx: MatrixClient, change: Partial<EmbedSettings>): Promise<void> {
  await mx.setAccountData(EMBED_SETTINGS_ACCOUNT_DATA as never, { ...readEmbedSettings(mx), ...change } as never);
}

/** The settings, kept current as they change (here or on another device). Signed out, the defaults. */
export function useEmbedSettings(): EmbedSettings {
  const mx = useContext(MatrixClientContext);
  const [settings, setSettings] = useState(() => (mx ? readEmbedSettings(mx) : DEFAULT_EMBED_SETTINGS));
  useEffect(() => {
    if (!mx) return undefined;
    const onAccountData = (event: MatrixEvent) => {
      if (event.getType() === EMBED_SETTINGS_ACCOUNT_DATA) setSettings(readEmbedSettings(mx));
    };
    setSettings(readEmbedSettings(mx));
    mx.on(ClientEvent.AccountData, onAccountData);
    return () => {
      mx.removeListener(ClientEvent.AccountData, onAccountData);
    };
  }, [mx]);
  return settings;
}
