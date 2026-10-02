import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { createContext } from 'react';
import { parseProfilePage, type ProfilePage } from '../../matrix/profilePage';
import type { PageTarget } from '../../matrix/publicWeb';
import { MusicPlayerBar } from '../music/MusicPlayerBar';
import { MusicPlayerHost } from '../music/MusicPlayerHost';
import { PageBlocks } from './PageBlocks';
import { PageOwnerContext } from './PageOwnerContext';
import { PageTargetContext } from './PageTargetContext';

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
const OWNER = '@luna:purr.example.org';

const legacy = parseProfilePage({
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

/** A page with the app's player beside it, as the app shell or the public frame has it. */
function renderPage(page: ProfilePage, target?: PageTarget) {
  return render(
    <Provider store={createStore()}>
      <PageOwnerContext.Provider value={{ userId: OWNER, isMe: false }}>
        <PageTargetContext.Provider value={target}>
          <PageBlocks blocks={page.blocks} />
        </PageTargetContext.Provider>
      </PageOwnerContext.Provider>
      <MusicPlayerHost />
      <MusicPlayerBar variant="bar" />
    </Provider>
  );
}

const all = (name: string) => Array.from(document.querySelectorAll<HTMLElement>(`[data-nu-role="${name}"]`));
const one = (name: string) => document.querySelector<HTMLElement>(`[data-nu-role="${name}"]`) as HTMLElement;
const audio = () => document.querySelector('audio') as HTMLAudioElement | null;

describe('the music block', () => {
  it('shows only album covers and titles, and asks for no track and has no audio until one is played', () => {
    renderPage(shelf);
    expect(all('music-album-card').map((card) => card.textContent)).toEqual(['First LP2024 · 2 tracks · 2:05', '♪Demo EP1 track']);
    expect(all('music-track')).toEqual([]);
    expect(audio()).toBeNull();
    expect(new Set(requested.mxcs.filter(Boolean))).toEqual(new Set([MXC('cover')]));
  });

  it('shows an older flat track list as one album card too', () => {
    renderPage(legacy);
    expect(all('music-album-card').map((card) => card.textContent)).toEqual(['♪Untitled album2 tracks']);
    expect(all('music-track')).toEqual([]);
  });

  it('opens an album over the page, and plays it through in the player, stopping at its end', () => {
    renderPage(shelf);
    fireEvent.click(all('music-album-card')[0]);
    expect(all('music-track').map((track) => track.textContent)).toEqual(['1Opening1:00', '2Closing1:05']);
    fireEvent.click(one('music-play-album'));
    expect(audio()?.getAttribute('src')).toBe('https://purr.example/api/public/media/purr.example.org/lp1');
    expect(audio()?.autoplay).toBe(true);
    expect(one('music-player-title').textContent).toBe('Opening');
    act(() => void fireEvent.ended(audio() as HTMLAudioElement));
    expect(audio()?.getAttribute('src')).toContain('/lp2');
    act(() => void fireEvent.ended(audio() as HTMLAudioElement));
    expect(audio()?.getAttribute('src')).toContain('/lp2');
    expect(requested.mxcs).not.toContain(MXC('ep1'));
  });

  it('keeps playing after the album is closed, and the card says it is the one playing', () => {
    renderPage(shelf);
    fireEvent.click(all('music-album-card')[0]);
    fireEvent.click(all('music-track')[1]);
    fireEvent.play(audio() as HTMLAudioElement);
    fireEvent.click(one('modal-close'));
    expect(all('music-track')).toEqual([]);
    expect(audio()?.getAttribute('src')).toContain('/lp2');
    expect(all('music-album-card')[0].textContent).toContain('Playing');
    expect(one('music-player-title').textContent).toBe('Closing');
  });

  it('pauses and resumes from the track and from the player', () => {
    renderPage(shelf);
    fireEvent.click(all('music-album-card')[0]);
    fireEvent.click(all('music-track')[0]);
    const element = audio() as HTMLAudioElement;
    fireEvent.play(element);
    expect(all('music-track')[0].getAttribute('aria-label')).toBe('Pause Opening');
    Object.defineProperty(element, 'paused', { value: false, configurable: true });
    fireEvent.click(all('music-track')[0]);
    expect(pause).toHaveBeenCalledTimes(1);
    Object.defineProperty(element, 'paused', { value: true, configurable: true });
    fireEvent.click(one('music-player-toggle'));
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('goes back and on from the player, and closing it stops the music', () => {
    renderPage(shelf);
    fireEvent.click(all('music-album-card')[0]);
    fireEvent.click(one('music-play-album'));
    fireEvent.click(one('music-player-next'));
    expect(audio()?.getAttribute('src')).toContain('/lp2');
    fireEvent.click(one('music-player-previous'));
    expect(audio()?.getAttribute('src')).toContain('/lp1');
    fireEvent.click(one('music-player-close'));
    expect(audio()).toBeNull();
    expect(one('music-player')).toBeNull();
  });

  it('remembers the volume as Listen Together does', () => {
    renderPage(shelf);
    fireEvent.click(all('music-album-card')[0]);
    fireEvent.click(one('music-play-album'));
    fireEvent.change(one('music-volume'), { target: { value: '0.3' } });
    expect(localStorage.getItem('nekous_listen_together_volume')).toBe('0.3');
    expect(audio()?.volume).toBeCloseTo(0.3);
  });

  it('says so when a track cannot be played', () => {
    renderPage(shelf);
    fireEvent.click(all('music-album-card')[0]);
    fireEvent.click(one('music-play-album'));
    fireEvent.error(audio() as HTMLAudioElement);
    expect(one('music-player').textContent).toContain('couldn’t be played');
  });

  it('gives the album and each track a link of its own', () => {
    renderPage(shelf);
    fireEvent.click(all('music-album-card')[0]);
    expect(one('music-album-link').dataset.nuLink).toBe(`${window.location.origin}/@luna/music/lp`);
    expect(all('music-track-link').map((link) => link.dataset.nuLink)).toEqual([
      `${window.location.origin}/@luna/music/lp/1`,
      `${window.location.origin}/@luna/music/lp/2`,
    ]);
  });

  it('opens the album a link points at, marking its track without playing it', () => {
    renderPage(shelf, { kind: 'music', album: 'lp', track: 2 });
    expect(all('music-track')).toHaveLength(2);
    expect(all('music-track')[1].className).toContain('nu-profile-page__track--linked');
    expect(audio()).toBeNull();
  });
});
