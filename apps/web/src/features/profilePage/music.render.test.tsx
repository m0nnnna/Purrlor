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

const shelf = parseProfilePage({
  version: 1,
  blocks: [
    {
      id: 'm',
      type: 'music',
      title: 'Releases',
      albums: [
        {
          id: 'lp',
          title: 'First LP',
          year: 2024,
          cover: MXC('cover'),
          tracks: [
            { url: MXC('lp1'), mimetype: 'audio/mpeg', title: 'Opening', duration: 60 },
            { url: MXC('lp2'), mimetype: 'audio/mpeg', title: 'Closing', duration: 65 },
          ],
        },
        { id: 'ep', title: 'Demo EP', tracks: [{ url: MXC('ep1'), mimetype: 'audio/ogg', title: 'Rough' }] },
      ],
    },
  ],
}) as ProfilePage;

const role = (container: HTMLElement, name: string) => Array.from(container.querySelectorAll<HTMLElement>(`[data-nu-role="${name}"]`));

describe('music albums', () => {
  it('shows a shelf of albums with their covers, and no tracks or audio until one is opened and played', () => {
    const { container } = render(<PageBlocks blocks={shelf.blocks} />);
    expect(role(container, 'music-album-card').map((card) => card.textContent)).toEqual(['First LP2024 · 2 tracks · 2:05', '♪Demo EP1 track']);
    expect(tracks(container)).toEqual([]);
    expect(container.querySelector('audio')).toBeNull();
    // Only the cover was asked for.
    expect(requested.mxcs.filter(Boolean)).toEqual(requested.mxcs.filter(Boolean).map(() => MXC('cover')));
  });

  it('opens an album to its tracks, plays it through, and stops at its end', () => {
    const { container } = render(<PageBlocks blocks={shelf.blocks} />);
    fireEvent.click(role(container, 'music-album-card')[0]);
    expect(tracks(container).map((track) => track.textContent)).toEqual(['▶Opening1:00', '▶Closing1:05']);
    fireEvent.click(role(container, 'music-play-album')[0]);
    const audio = () => container.querySelector('audio') as HTMLAudioElement;
    expect(audio().getAttribute('src')).toContain('/lp1');
    fireEvent.ended(audio());
    expect(audio().getAttribute('src')).toContain('/lp2');
    fireEvent.ended(audio());
    // The album is over: the next album doesn't start by itself.
    expect(audio().getAttribute('src')).toContain('/lp2');
    expect(requested.mxcs.some((mxc) => mxc === MXC('ep1'))).toBe(false);
  });

  it('keeps playing while another album is open, and says what is playing', () => {
    const { container } = render(<PageBlocks blocks={shelf.blocks} />);
    fireEvent.click(role(container, 'music-album-card')[0]);
    fireEvent.click(tracks(container)[0]);
    fireEvent.play(container.querySelector('audio') as Element);
    fireEvent.click(role(container, 'music-albums-back')[0]);
    expect(role(container, 'music-album-card')[0].textContent).toContain('Playing');
    fireEvent.click(role(container, 'music-album-card')[1]);
    expect(tracks(container).map((track) => track.textContent)).toEqual(['▶Rough']);
    expect(container.querySelector('audio')?.getAttribute('src')).toContain('/lp1');
    expect(role(container, 'music-now-playing')[0].textContent).toContain('OpeningFirst LP');
  });

  it('shows a lone album open, with no shelf or way back', () => {
    const { container } = render(<PageBlocks blocks={page.blocks} />);
    expect(role(container, 'music-album-card')).toEqual([]);
    expect(role(container, 'music-albums-back')).toEqual([]);
    expect(tracks(container)).toHaveLength(2);
  });
});
