import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createContext } from 'react';
import { parseProfilePage, type ProfilePage } from '../../matrix/profilePage';
import { PageBlocks } from './PageBlocks';

const requested = vi.hoisted(() => ({ mxcs: [] as (string | null | undefined)[] }));
vi.mock('../../matrix/MatrixClientContext', () => ({
  MatrixClientContext: createContext(undefined),
  useMatrixClient: () => {
    throw new Error('signed out: no client');
  },
}));
vi.mock('../../matrix/hooks/useMediaUrl', () => ({
  useMediaUrl: (mxc: string | null | undefined) => {
    requested.mxcs.push(mxc);
    return mxc ? `https://purr.example/api/public/media/${mxc.split('//')[1]}` : null;
  },
}));

const play = vi.fn(() => Promise.resolve());
const pause = vi.fn();

beforeEach(() => {
  requested.mxcs.length = 0;
  play.mockClear();
  pause.mockClear();
  // jsdom has no media playback.
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(play);
  vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(pause);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

const MXC = (id: string) => `mxc://purr.example.org/${id}`;
const page = parseProfilePage({
  version: 1,
  blocks: [
    {
      id: 'm',
      type: 'music',
      title: 'Demos',
      tracks: [
        { url: MXC('one'), mimetype: 'audio/mpeg', title: 'First', artist: 'Luna', duration: 205 },
        { url: MXC('two'), mimetype: 'audio/ogg', title: 'Second' },
      ],
    },
  ],
}) as ProfilePage;

const tracks = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLButtonElement>('[data-nu-role="music-track"]'));

describe('the music block', () => {
  it('lists the tracks, and asks for no file and has no audio element until play is pressed', () => {
    const { container } = render(<PageBlocks blocks={page.blocks} />);
    expect(tracks(container).map((track) => track.textContent)).toEqual(['▶FirstLuna3:25', '▶Second']);
    expect(container.querySelector('audio')).toBeNull();
    expect(requested.mxcs.filter(Boolean)).toEqual([]);
  });

  it('plays the track pressed, straight from the public media route when signed out', () => {
    const { container } = render(<PageBlocks blocks={page.blocks} />);
    fireEvent.click(tracks(container)[0]);
    const audio = container.querySelector('audio') as HTMLAudioElement;
    expect(audio.getAttribute('src')).toBe('https://purr.example/api/public/media/purr.example.org/one');
    expect(audio.autoplay).toBe(true);
    // Only the pressed track was ever asked for.
    expect(requested.mxcs.filter(Boolean).every((mxc) => mxc === MXC('one'))).toBe(true);
    expect(container.querySelector('[data-nu-role="music-seek"]')).not.toBeNull();
    expect(container.querySelector('[data-nu-role="music-volume"]')).not.toBeNull();
  });

  it('pauses and resumes with the same button, and goes on to the next track when one ends', () => {
    const { container } = render(<PageBlocks blocks={page.blocks} />);
    fireEvent.click(tracks(container)[0]);
    const audio = container.querySelector('audio') as HTMLAudioElement;
    fireEvent.play(audio);
    expect(tracks(container)[0].getAttribute('aria-label')).toBe('Pause First by Luna');

    Object.defineProperty(audio, 'paused', { value: false, configurable: true });
    fireEvent.click(tracks(container)[0]);
    expect(pause).toHaveBeenCalledTimes(1);

    Object.defineProperty(audio, 'paused', { value: true, configurable: true });
    fireEvent.click(tracks(container)[0]);
    expect(play).toHaveBeenCalledTimes(1);

    fireEvent.ended(audio);
    expect((container.querySelector('audio') as HTMLAudioElement).getAttribute('src')).toContain('/two');
  });

  it('remembers the volume as Listen Together does', () => {
    const { container } = render(<PageBlocks blocks={page.blocks} />);
    fireEvent.click(tracks(container)[0]);
    fireEvent.change(container.querySelector('[data-nu-role="music-volume"]') as Element, { target: { value: '0.3' } });
    expect(localStorage.getItem('nekous_listen_together_volume')).toBe('0.3');
    expect((container.querySelector('audio') as HTMLAudioElement).volume).toBeCloseTo(0.3);
  });

  it('says so when a track cannot be played', () => {
    const { container } = render(<PageBlocks blocks={page.blocks} />);
    fireEvent.click(tracks(container)[0]);
    fireEvent.error(container.querySelector('audio') as Element);
    expect(container.textContent).toContain('couldn’t be played');
  });
});
