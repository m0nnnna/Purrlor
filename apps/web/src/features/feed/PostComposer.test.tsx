import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { MatrixClientContext } from '../../matrix/MatrixClientContext';
import { PostComposer, type ComposerTarget } from './PostComposer';

const video = { kind: 'video', mimetype: 'video/mp4', name: 'a.mp4', file: new Blob(['x']), previewUrl: 'blob:v', tags: [] };
const image = { kind: 'image', mimetype: 'image/webp', name: 'a.webp', file: new Blob(['x']), previewUrl: 'blob:i', tags: [] };
const staging = vi.hoisted(() => ({ staged: [] as unknown[] }));

vi.mock('./useStagedMedia', () => ({
  useStagedMedia: () => ({
    staged: staging.staged,
    preparing: false,
    savedBytes: 0,
    full: false,
    addPicked: vi.fn(),
    addFiles: vi.fn(),
    addPasted: vi.fn(),
    remove: vi.fn(),
    setTags: vi.fn(),
    clear: vi.fn(),
    upload: vi.fn(),
  }),
  StagedMediaPreviews: () => null,
}));
vi.mock('../../matrix/videos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../matrix/videos')>()),
  probeVideo: () => new Promise(() => undefined),
}));
vi.mock('../../matrix/hooks/useOwnProfile', () => ({ useOwnProfile: () => ({ displayName: 'Me' }) }));
vi.mock('../../matrix/hooks/useEmoteLibrary', () => ({ useWithLibraryEmotes: (emotes: unknown) => emotes }));
vi.mock('../../matrix/hooks/useRoomMembers', () => ({ useRoomMembers: () => [] }));
vi.mock('../../matrix/hooks/useComposerEmbeds', () => ({
  useComposerEmbeds: () => ({ previews: [], remove: vi.fn(), reset: vi.fn(), prepare: vi.fn() }),
}));

const mx = { getUsers: () => [], getUserId: () => '@me:x' };
const globalTarget: ComposerTarget = { id: 'global', label: 'Global', isPublic: true, target: { kind: 'global' } };
const space = (isPublic: boolean): ComposerTarget => ({ id: '!s', label: 'S', isPublic, target: { kind: 'space', space: { roomId: '!s' } as never } });

function show(target: ComposerTarget, staged: unknown[]) {
  staging.staged = staged;
  return render(
    <JotaiProvider>
      <MatrixClientContext.Provider value={mx as never}>
        <PostComposer targets={[target]} placeholder="" />
      </MatrixClientContext.Provider>
    </JotaiProvider>
  );
}

afterEach(() => {
  cleanup();
  staging.staged = [];
});

describe('PostComposer: also add to WATCH', () => {
  it('offers the switch, on, for a video going to the global feed', () => {
    show(globalTarget, [video]);
    const toggle = screen.getByText('Also add to WATCH').closest('[data-nu-role="post-composer-watch-toggle"]');
    expect(toggle).not.toBeNull();
    expect((toggle!.querySelector('input') as HTMLInputElement).checked).toBe(true);
  });

  it('offers it for a public Space too', () => {
    show(space(true), [video]);
    expect(screen.queryByText('Also add to WATCH')).not.toBeNull();
  });

  it('hides it for a members-only Space, whose media is encrypted', () => {
    show(space(false), [video]);
    expect(screen.queryByText('Also add to WATCH')).toBeNull();
  });

  it('hides it when the post has no video', () => {
    show(globalTarget, [image]);
    expect(screen.queryByText('Also add to WATCH')).toBeNull();
  });
});
