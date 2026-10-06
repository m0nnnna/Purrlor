import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { profileRevisionAtom } from '../../app/state/feed';
import { useMatrixClient } from '../MatrixClientContext';
import { getExtendedProfile, keptExtendedProfile, keptExtendedProfileNow, type ExtendedProfile } from '../extendedProfile';

/** A kept profile younger than this is shown without asking again. */
const FRESH_MS = 5 * 60_000;

/**
 * Fetches a user's bio/banner/animated-avatar-flag on demand — see extendedProfile.ts for why
 * this can't be "live" the way displayname/avatar_url are (no sync delivery for MSC4133 fields).
 * What was read last time (extendedProfile.ts keeps it, in memory and on the device) is shown at
 * once, and asked for again only once it's a few minutes old. Your own changes forget your own
 * copy, and bump `profileRevisionAtom`, so a profile already on screen shows them.
 */
export function useExtendedProfile(userId: string | undefined): { profile: ExtendedProfile; loading: boolean } {
  const mx = useMatrixClient();
  const [profile, setProfile] = useState<ExtendedProfile>(() => (userId && keptExtendedProfileNow(userId)) || {});
  const [loading, setLoading] = useState(!!userId && !keptExtendedProfileNow(userId));
  // Bumped after your own profile changes from elsewhere in the app (pinning a post), so a
  // profile already on screen shows it.
  const revision = useAtomValue(profileRevisionAtom);

  useEffect(() => {
    if (!userId) {
      setProfile({});
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      const kept = await keptExtendedProfile(userId);
      if (cancelled) return;
      if (kept) {
        setProfile(kept.profile);
        setLoading(false);
        if (Date.now() - kept.at < FRESH_MS) return;
      } else {
        setLoading(true);
      }
      const result = await getExtendedProfile(mx, userId);
      if (!cancelled) {
        setProfile(result);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mx, userId, revision]);

  return { profile, loading };
}
