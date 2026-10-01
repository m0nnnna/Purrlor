import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { usePauseWhenOffscreen } from './usePauseWhenOffscreen';

type Callback = (entries: { isIntersecting: boolean }[]) => void;
const observers: { callback: Callback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];

function stubObserver() {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: Callback) {
        observers.push({ callback, observe: this.observe, disconnect: this.disconnect });
      }
    }
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  observers.length = 0;
});

function Player() {
  const ref = usePauseWhenOffscreen();
  return <video ref={ref} data-testid="video" />;
}

describe('usePauseWhenOffscreen', () => {
  it('pauses a playing video when it leaves the screen, and leaves it alone when it comes back', () => {
    stubObserver();
    const pause = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const { getByTestId } = render(<Player />);
    const video = getByTestId('video') as HTMLVideoElement;
    Object.defineProperty(video, 'paused', { value: false, configurable: true });

    expect(observers).toHaveLength(1);
    expect(observers[0].observe).toHaveBeenCalledWith(video);
    observers[0].callback([{ isIntersecting: true }]);
    expect(pause).not.toHaveBeenCalled();
    observers[0].callback([{ isIntersecting: false }]);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('does not pause one that is not playing', () => {
    stubObserver();
    const pause = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    render(<Player />);
    observers[0].callback([{ isIntersecting: false }]);
    expect(pause).not.toHaveBeenCalled();
  });

  it('stops watching when the player goes away', () => {
    stubObserver();
    const { unmount } = render(<Player />);
    unmount();
    expect(observers[0].disconnect).toHaveBeenCalled();
  });

  it('does nothing where IntersectionObserver is missing', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    expect(() => render(<Player />)).not.toThrow();
  });
});
