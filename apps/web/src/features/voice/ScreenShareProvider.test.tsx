import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { Track } from 'livekit-client';
import type { TrackReference } from '@livekit/components-react';
import { pickActiveShare, ScreenShareProvider, useCallScreenShare } from './ScreenShareProvider';

// jsdom has no MediaStream.
vi.stubGlobal('MediaStream', class {});

type FakePublication = { source: Track.Source; isDesired: boolean; setSubscribed: (on: boolean) => void };

function sharer(identity: string, isLocal = false) {
  const publication = (source: Track.Source): FakePublication => {
    const pub: FakePublication = {
      source,
      isDesired: true, // LiveKit subscribes to everything by default
      setSubscribed: vi.fn((on: boolean) => (pub.isDesired = on)),
    };
    return pub;
  };
  const video = publication(Track.Source.ScreenShare);
  const audio = publication(Track.Source.ScreenShareAudio);
  const participant = { identity, isLocal, trackPublications: new Map([['v', video], ['a', audio]]) };
  const ref = {
    participant,
    source: Track.Source.ScreenShare,
    publication: { track: { mediaStreamTrack: { id: identity } } },
  } as unknown as TrackReference;
  return { ref, video, audio, participant };
}

let shares: ReturnType<typeof sharer>[] = [];
vi.mock('@livekit/components-react', () => ({
  useTracks: (sources: Track.Source[]) => (sources[0] === Track.Source.ScreenShare ? shares.map((s) => s.ref) : []),
  useRoomContext: () => ({
    remoteParticipants: new Map(shares.filter((s) => !s.participant.isLocal).map((s) => [s.participant.identity, s.participant])),
  }),
}));

let call: ReturnType<typeof useCallScreenShare>;
function CallPane() {
  call = useCallScreenShare();
  return <p>call pane</p>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  shares = [];
});

describe('pickActiveShare', () => {
  const mine = sharer('@me:purr', true).ref;
  const alice = sharer('@alice:purr').ref;
  const bob = sharer('@bob:purr').ref;

  it('shows the share you picked', () => {
    expect(pickActiveShare([mine, alice, bob], '@bob:purr')).toBe(bob);
    expect(pickActiveShare([mine, alice, bob], '@me:purr')).toBe(mine);
  });

  it("shows someone else's before your own when nothing is picked, or the picked one ended", () => {
    expect(pickActiveShare([mine, alice], null)).toBe(alice);
    expect(pickActiveShare([mine, alice], '@bob:purr')).toBe(alice);
    expect(pickActiveShare([mine], null)).toBe(mine);
    expect(pickActiveShare([], null)).toBeUndefined();
  });
});

describe('ScreenShareProvider', () => {
  it('receives only the share being watched, and switches when another is picked', () => {
    const alice = sharer('@alice:purr');
    const bob = sharer('@bob:purr');
    shares = [sharer('@me:purr', true), alice, bob];
    render(
      <ScreenShareProvider>
        <CallPane />
      </ScreenShareProvider>
    );
    expect(call.active).toBe(alice.ref);
    expect([alice.video.isDesired, alice.audio.isDesired]).toEqual([true, true]);
    expect([bob.video.isDesired, bob.audio.isDesired]).toEqual([false, false]);

    act(() => call.select('@bob:purr'));
    expect(call.active).toBe(bob.ref);
    expect([alice.video.isDesired, alice.audio.isDesired]).toEqual([false, false]);
    expect([bob.video.isDesired, bob.audio.isDesired]).toEqual([true, true]);

    // Someone who is sharing can watch their own screen too.
    act(() => call.select('@me:purr'));
    expect(call.active?.participant.isLocal).toBe(true);
    expect([alice.video.isDesired, bob.video.isDesired]).toEqual([false, false]);
  });

  it('keeps the pop-out open when another channel replaces the call pane, and closes it with the call', () => {
    shares = [sharer('@alice:purr')];
    const win = { closed: false, close: vi.fn(() => (win.closed = true)), document: document.implementation.createHTMLDocument('') };
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);

    const { rerender, unmount } = render(
      <ScreenShareProvider>
        <CallPane />
      </ScreenShareProvider>
    );
    act(() => call.popout.toggle());
    expect(window.open).toHaveBeenCalledOnce();
    expect(call.popout.isOpen).toBe(true);

    // Opening a text channel: the call pane goes, the call (and its provider) stays.
    rerender(
      <ScreenShareProvider>
        <p>a text channel</p>
      </ScreenShareProvider>
    );
    expect(win.close).not.toHaveBeenCalled();

    // Leaving the call.
    unmount();
    expect(win.close).toHaveBeenCalled();
  });
});
