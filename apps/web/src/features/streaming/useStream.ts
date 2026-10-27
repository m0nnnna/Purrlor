import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { fetchLiveStreams, fetchStream, fetchStreamsOf, streamBaseFor, type PublicStream } from '../../matrix/liveStream';

const LIVE_POLL_MS = 15_000;
const PROFILE_POLL_MS = 30_000;

/** Where `userId`'s streams are (liveStream.ts, streamBaseFor): `''` here, a peer's address, or undefined. */
export function useStreamBase(userId: string | undefined, ownServer: string | undefined): string | undefined {
  const [base, setBase] = useState<string>();
  useEffect(() => {
    setBase(undefined);
    if (!userId) return undefined;
    let cancelled = false;
    void streamBaseFor(userId, ownServer).then((found) => {
      if (!cancelled) setBase(found);
    });
    return () => {
      cancelled = true;
    };
  }, [userId, ownServer]);
  return base;
}

/** One stream, asked again every 15 s while it's live (the viewer count, and noticing it end). */
export function useStream(base: string | undefined, id: string | undefined): { stream?: PublicStream; loaded: boolean } {
  const [state, setState] = useState<{ stream?: PublicStream; loaded: boolean }>({ loaded: false });
  useEffect(() => {
    setState({ loaded: false });
    if (base === undefined || !id) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const read = () => {
      void fetchStream(base, id)
        .then((stream) => {
          if (cancelled) return;
          setState({ stream, loaded: true });
          if (stream?.state === 'live') timer = window.setTimeout(read, LIVE_POLL_MS);
        })
        .catch(() => {
          if (cancelled) return;
          setState((prev) => ({ ...prev, loaded: true }));
          timer = window.setTimeout(read, LIVE_POLL_MS);
        });
    };
    read();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [base, id]);
  return state;
}

/**
 * A profile's streams (live, or ended and not yet expired), newest first. Asked when the profile
 * opens and every 30 s while it's showing, so going live shows up without a reload. `undefined`
 * until the first answer. The setter is for the Streams tab, which renames and deletes.
 */
export function useProfileStreams(
  ownerId: string | undefined,
  base: string | undefined,
  refresh?: unknown
): [PublicStream[] | undefined, Dispatch<SetStateAction<PublicStream[] | undefined>>] {
  const [streams, setStreams] = useState<PublicStream[]>();
  useEffect(() => {
    if (!ownerId || base === undefined) {
      setStreams(undefined);
      return undefined;
    }
    let cancelled = false;
    let timer: number | undefined;
    const read = () => {
      void fetchStreamsOf(base, ownerId)
        .then((found) => {
          if (!cancelled) setStreams(found);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) timer = window.setTimeout(read, PROFILE_POLL_MS);
        });
    };
    read();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ownerId, base, refresh]);
  return [streams, setStreams];
}

/** What a profile shows above its posts: its owner's live stream, or else their newest replay. */
export function streamToShow(streams: PublicStream[] | undefined): PublicStream | undefined {
  return streams?.find((s) => s.state === 'live') ?? streams?.find((s) => s.replay);
}

export function useProfileStream(ownerId: string | undefined, base: string | undefined, refresh?: unknown): PublicStream | undefined {
  return streamToShow(useProfileStreams(ownerId, base, refresh)[0]);
}

/** The streams live on this server, asked every 30 s while the caller is mounted (Home's "Live now"). */
export function useLiveStreams(base: string | undefined, enabled: boolean): PublicStream[] {
  const [streams, setStreams] = useState<PublicStream[]>([]);
  useEffect(() => {
    if (!enabled || base === undefined) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const read = () => {
      void fetchLiveStreams(base)
        .then((found) => {
          if (!cancelled) setStreams(found);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) timer = window.setTimeout(read, PROFILE_POLL_MS);
        });
    };
    read();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [base, enabled]);
  return enabled ? streams : [];
}
