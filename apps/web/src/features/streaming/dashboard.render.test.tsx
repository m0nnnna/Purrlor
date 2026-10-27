import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { PublicStream } from '../../matrix/liveStream';
import { MatrixClientContext } from '../../matrix/MatrixClientContext';
import { Dashboard } from './Dashboard';
import { StreamChat } from './StreamChat';
import { dashboardOpenAtom, streamerAtom } from './streamerState';

const calls = vi.hoisted(() => ({ moderated: [] as unknown[] }));
vi.mock('../../matrix/liveStream', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../matrix/liveStream')>()),
  fetchChat: async () => ({
    messages: [
      { id: '$1', ts: 1, sender: '@bob:purr.example', body: 'hi' },
      { id: '$2', ts: 2, sender: '@luna:purr.example', body: 'streamer here' },
    ],
    avatars: {},
  }),
  moderateStream: async (_mx: unknown, _id: string, what: unknown) => {
    calls.moderated.push(what);
    return { '@bob:purr.example': Date.now() + 5 * 60_000 };
  },
}));
vi.mock('./GoLive', () => ({
  streamerSession: async () => ({
    attachPreview: () => () => undefined,
    readHealth: async () => ({ width: 1280, height: 720, fps: 30, kbps: 2400 }),
    hasSharedSound: () => false,
  }),
}));

const stream: PublicStream = {
  id: 'aaaaaaaaaaaaaaaa',
  owner: '@luna:purr.example',
  title: 'On air',
  state: 'live',
  liveAt: Date.now() - 65_000,
  endedAt: null,
  viewers: 3,
  chatRoom: '!chat:purr.example',
  thumbnail: null,
  replay: null,
  expiresAt: null,
  source: 'obs',
};

afterEach(() => {
  cleanup();
  calls.moderated.length = 0;
});

describe('moderating the chat', () => {
  it('offers no moderation signed out, even when asked', async () => {
    const moderate = vi.fn();
    const { container } = render(<StreamChat base="" stream={stream} onSignIn={() => undefined} moderate={moderate} />);
    // Signed out the chat is the read-only one: no actions there.
    await waitFor(() => expect(screen.getByText('hi')).toBeTruthy());
    expect(container.querySelector('[data-nu-role="stream-chat-mod"]')).toBeNull();
  });
});

describe('the dashboard', () => {
  it('shows the stats, and runs the moderation actions with the right fields', async () => {
    const store = createStore();
    store.set(dashboardOpenAtom, true);
    store.set(streamerAtom, { phase: 'live', stream, source: 'obs', viewers: 3, micOn: false, soundOn: false, posted: false });
    // The streamer's own chat is the Matrix one; stand in a client with the room's timeline empty.
    const mx = {
      getUserId: () => stream.owner,
      getRoom: () => ({ getMyMembership: () => 'join', getLiveTimeline: () => ({ getEvents: () => [] }), getMember: () => null }),
      on: () => undefined,
      off: () => undefined,
      createMessagesRequest: async () => ({
        chunk: [
          { type: 'm.room.message', event_id: '$1', room_id: '!chat:purr.example', sender: '@bob:purr.example', origin_server_ts: 1, content: { msgtype: 'm.text', body: 'hi' } },
          { type: 'm.room.message', event_id: '$2', room_id: '!chat:purr.example', sender: stream.owner, origin_server_ts: 2, content: { msgtype: 'm.text', body: 'streamer here' } },
        ],
      }),
      sendMessage: async () => undefined,
    };
    const { container } = render(
      <Provider store={store}>
        <MatrixClientContext.Provider value={mx as never}>
          <Dashboard />
        </MatrixClientContext.Provider>
      </Provider>
    );
    expect(screen.getByText('LIVE')).toBeTruthy();
    expect(container.querySelector('[data-nu-role="dashboard-viewers"]')?.textContent).toBe('3');
    await waitFor(() => expect(container.querySelector('[data-nu-role="dashboard-health"]')?.textContent).toBe('1280×720 · 30 fps · 2.4 Mbps'));
    // OBS: no browser-only controls.
    expect(container.querySelector('[data-nu-role="dashboard-change-screen"]')).toBeNull();

    await waitFor(() => expect(container.querySelectorAll('[data-nu-role="stream-chat-line"]')).toHaveLength(2));
    const lines = container.querySelectorAll('[data-nu-role="stream-chat-line"]');
    expect(lines[1].querySelector('[data-nu-role="stream-chat-mod"]')).toBeNull();
    const mod = lines[0].querySelector('[data-nu-role="stream-chat-mod"]')!;
    fireEvent.click(mod.querySelector('[data-nu-role="mod-delete"]')!);
    fireEvent.click(mod.querySelector('[data-nu-minutes="10"]')!);
    fireEvent.click(mod.querySelector('[data-nu-role="mod-ban"]')!);
    await waitFor(() => expect(calls.moderated).toHaveLength(3));
    expect(calls.moderated).toEqual([
      { action: 'delete', eventId: '$1' },
      { action: 'timeout', user: '@bob:purr.example', minutes: 10 },
      { action: 'ban', user: '@bob:purr.example' },
    ]);

    // The running timeout is listed with Untimeout, and the ban with Unban.
    await waitFor(() => expect(container.querySelector('[data-nu-role="mod-untimeout"]')).toBeTruthy());
    fireEvent.click(container.querySelector('[data-nu-role="mod-untimeout"]')!);
    fireEvent.click(container.querySelector('[data-nu-role="mod-unban"]')!);
    await waitFor(() => expect(calls.moderated).toHaveLength(5));
    expect(calls.moderated.slice(3)).toEqual([
      { action: 'untimeout', user: '@bob:purr.example' },
      { action: 'unban', user: '@bob:purr.example' },
    ]);
  });
});
