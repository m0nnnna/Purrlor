import { useEffect, useState } from 'react';
import { fetchStream, fetchStreamsOf, streamBaseFor, type PublicStream } from '../../matrix/liveStream';

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
 * What a profile shows: its owner's live stream, or else their newest replay. Asked when the
 * profile opens and every 30 s while it's showing, so going live shows up without a reload.
 */
export function useProfileStream(ownerId: string | undefined, base: string | undefined, refresh?: unknown): PublicStream | undefined {
  const [stream, setStream] = useState<PublicStream>();
  useEffect(() => {
    if (!ownerId || base === undefined) {
      setStream(undefined);
      return undefined;
    }
    let cancelled = false;
    let timer: number | undefined;
    const read = () => {
      void fetchStreamsOf(base, ownerId)
        .then((streams) => {
          if (!cancelled) setStream(streams.find((s) => s.state === 'live') ?? streams.find((s) => s.replay));
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
  return stream;
}
