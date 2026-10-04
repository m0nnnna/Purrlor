import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ScreenSharePopoutProvider, useCallScreenSharePopout } from './ScreenSharePopoutProvider';

const track = { kind: 'video' } as unknown as MediaStreamTrack;
vi.mock('@livekit/components-react', () => ({
  useTracks: () => [{ publication: { track: { mediaStreamTrack: track } } }],
}));

// jsdom has no MediaStream.
vi.stubGlobal('MediaStream', class {});

function fakeWindow() {
  const win = { closed: false, close: vi.fn(() => (win.closed = true)), document: document.implementation.createHTMLDocument('') };
  return win;
}

let popout: ReturnType<typeof useCallScreenSharePopout>;
function CallPane() {
  popout = useCallScreenSharePopout();
  return <p>call pane</p>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ScreenSharePopoutProvider', () => {
  it('keeps the pop-out open when another channel replaces the call pane, and closes it with the call', () => {
    const win = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);

    const { rerender, unmount } = render(
      <ScreenSharePopoutProvider>
        <CallPane />
      </ScreenSharePopoutProvider>
    );
    act(() => popout.toggle());
    expect(window.open).toHaveBeenCalledOnce();
    expect(popout.isOpen).toBe(true);

    // Opening a text channel: the call pane goes, the call (and its provider) stays.
    rerender(
      <ScreenSharePopoutProvider>
        <p>a text channel</p>
      </ScreenSharePopoutProvider>
    );
    expect(win.close).not.toHaveBeenCalled();

    // Leaving the call.
    unmount();
    expect(win.close).toHaveBeenCalled();
  });
});
