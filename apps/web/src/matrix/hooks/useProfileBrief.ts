import { useEffect, useState } from 'react';
import { useMatrixClient } from '../MatrixClientContext';
import { handleFor } from '../roles';

export type ProfileBrief = { name: string; avatarUrl?: string };

const known = new Map<string, Promise<ProfileBrief>>();

/** A person's name and avatar, for a list of people you may share no rooms with (a Top 8, a guestbook). */
export function useProfileBrief(userId: string): ProfileBrief {
  const mx = useMatrixClient();
  const [brief, setBrief] = useState<ProfileBrief>(() => {
    const user = mx.getUser(userId);
    return { name: user?.displayName || handleFor(userId), avatarUrl: user?.avatarUrl || undefined };
  });

  useEffect(() => {
    let cancelled = false;
    let lookup = known.get(userId);
    if (!lookup) {
      lookup = mx
        .getProfileInfo(userId)
        .then((info): ProfileBrief => ({ name: info.displayname || handleFor(userId), avatarUrl: info.avatar_url }))
        .catch((): ProfileBrief => ({ name: handleFor(userId) }));
      known.set(userId, lookup);
    }
    void lookup.then((result) => {
      if (!cancelled) setBrief(result);
    });
    return () => {
      cancelled = true;
    };
  }, [mx, userId]);

  return brief;
}
