import { useEffect, useState } from 'react';
import { UserEvent } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { fallbackName, nameOrFallback } from '../displayName';

type OwnProfile = {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
};

// Deliberately NOT `mx.getUser(userId)?.displayName`/`.avatarUrl`: every store implementation in
// matrix-js-sdk (MemoryStore, and IndexedDBStore which extends it unchanged) shares one `User`
// object per user ID and silently overwrites those exact fields from *any* room's
// `m.room.member` event for that user — see MemoryStore.onRoomMember — with no event emitted.
// Once per-server nicknames (nicknames.ts) writes even one per-room displayname override for
// yourself, that field permanently reflects whichever room's override was applied most recently,
// not your account's real global profile. The profile API is the only reliable source.
async function fetchProfile(mx: ReturnType<typeof useMatrixClient>): Promise<OwnProfile> {
  const userId = mx.getUserId() ?? '';
  if (!userId) return { userId, displayName: '', avatarUrl: null };
  const profile = await mx.getProfileInfo(userId).catch(() => undefined);
  return {
    userId,
    displayName: nameOrFallback(profile?.displayname, userId),
    avatarUrl: profile?.avatar_url ?? null,
  };
}

/** The signed-in user's own display name/avatar, live-updated (e.g. right after
 *  AccountSettingsModal saves a change) via the same User-object events every other profile
 *  read in this app relies on (see usePresence.ts) — used here only as a "something changed,
 *  refetch" signal, not read directly (see fetchProfile above). */
export function useOwnProfile(): OwnProfile {
  const mx = useMatrixClient();
  const userId = mx.getUserId() ?? '';
  const [profile, setProfile] = useState<OwnProfile>({ userId, displayName: fallbackName(userId), avatarUrl: null });

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void fetchProfile(mx).then((p) => {
        if (!cancelled) setProfile(p);
      });
    };
    refresh();

    const onDisplayName = (_event: unknown, user: { userId: string }) => {
      if (user.userId === userId) refresh();
    };
    const onAvatarUrl = (_event: unknown, user: { userId: string }) => {
      if (user.userId === userId) refresh();
    };
    mx.on(UserEvent.DisplayName, onDisplayName);
    mx.on(UserEvent.AvatarUrl, onAvatarUrl);
    return () => {
      cancelled = true;
      mx.removeListener(UserEvent.DisplayName, onDisplayName);
      mx.removeListener(UserEvent.AvatarUrl, onAvatarUrl);
    };
  }, [mx, userId]);

  return profile;
}
