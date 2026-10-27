import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { PublicStream } from '../../matrix/liveStream';
import { StreamList } from './StreamList';

const calls = vi.hoisted(() => ({ renamed: [] as string[], deleted: [] as string[] }));
vi.mock('../../matrix/liveStream', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../matrix/liveStream')>()),
  renameStream: async (_mx: unknown, id: string, title: string) => {
    calls.renamed.push(title);
    return { ...ended, id, title };
  },
  deleteStream: async (_mx: unknown, id: string) => {
    calls.deleted.push(id);
  },
}));

const OWNER = '@luna:purr.example';
const base = {
  owner: OWNER,
  liveAt: 1000,
  chatRoom: null,
  thumbnail: null,
  replay: null,
  expiresAt: null,
  source: 'browser' as const,
};
const live: PublicStream = { ...base, id: 'aaaaaaaaaaaaaaaa', title: 'On air', state: 'live', endedAt: null, viewers: 3 };
const ended: PublicStream = {
  ...base,
  id: 'bbbbbbbbbbbbbbbb',
  title: 'Earlier',
  state: 'ended',
  endedAt: Date.now() - 2 * 3_600_000,
  replay: { durationMs: 65_000, url: '/api/public/streams/bbbbbbbbbbbbbbbb/replay' },
  expiresAt: Date.now() + 2 * 86_400_000,
};

function Harness({ me, initial }: { me: string; initial: PublicStream[] }) {
  const [streams, setStreams] = useState<PublicStream[] | undefined>(initial);
  return <StreamList base="" owner={OWNER} mx={{ getUserId: () => me } as never} streams={streams ?? []} setStreams={setStreams} onOpen={() => undefined} />;
}

afterEach(() => {
  cleanup();
  calls.renamed.length = 0;
  calls.deleted.length = 0;
});

describe('the Streams tab', () => {
  it('shows each stream with its state, and the owner’s empty note', () => {
    const { container } = render(<Harness me={OWNER} initial={[live, ended]} />);
    expect(container.querySelectorAll('[data-nu-role="stream-tile"]')).toHaveLength(2);
    expect(screen.getByText('LIVE')).toBeTruthy();
    expect(screen.getByText(/gone in 2 days/)).toBeTruthy();
    cleanup();
    render(<Harness me={OWNER} initial={[]} />);
    expect(screen.getByText(/show here for 3 days after they end/)).toBeTruthy();
  });

  it('offers rename and delete to the streamer only', () => {
    const { container } = render(<Harness me="@bob:purr.example" initial={[ended]} />);
    expect(container.querySelector('[data-nu-role="stream-tile-actions"]')).toBeNull();
  });

  it('renames on Enter, cancels on Esc, and deletes after a confirm', async () => {
    const { container } = render(<Harness me={OWNER} initial={[live, ended]} />);
    const tile = (n: number) => container.querySelectorAll('[data-nu-role="stream-tile"]')[n] as HTMLElement;
    // A live stream can be renamed but not deleted.
    expect(tile(0).querySelector('[data-nu-role="stream-tile-delete"]')).toBeNull();

    fireEvent.click(tile(1).querySelector('[data-nu-role="stream-tile-rename"]')!);
    fireEvent.keyDown(tile(1).querySelector('input')!, { key: 'Escape' });
    expect(tile(1).querySelector('input')).toBeNull();
    fireEvent.click(tile(1).querySelector('[data-nu-role="stream-tile-rename"]')!);
    const input = tile(1).querySelector('input')!;
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('Renamed')).toBeTruthy());
    expect(calls.renamed).toEqual(['Renamed']);

    fireEvent.click(tile(1).querySelector('[data-nu-role="stream-tile-delete"]')!);
    expect(calls.deleted).toEqual([]);
    fireEvent.click(tile(1).querySelector('[data-nu-role="stream-tile-delete-yes"]')!);
    await waitFor(() => expect(container.querySelectorAll('[data-nu-role="stream-tile"]')).toHaveLength(1));
    expect(calls.deleted).toEqual([ended.id]);
  });
});
