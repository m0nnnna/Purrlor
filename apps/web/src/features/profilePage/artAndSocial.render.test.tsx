import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createContext } from 'react';
import { parseProfilePage, type ProfilePage } from '../../matrix/profilePage';
import { PageBlocks } from './PageBlocks';
import { PageOwnerContext } from './PageOwnerContext';
import { visiblePieces } from './ArtBlock';

const over18 = vi.hoisted(() => ({ value: false }));
vi.mock('../../matrix/hooks/useOver18', () => ({ useOver18: () => over18.value }));
vi.mock('../../matrix/MatrixClientContext', () => ({
  MatrixClientContext: createContext(undefined),
  useMatrixClient: () => {
    throw new Error('signed out: no client');
  },
}));
vi.mock('../../matrix/hooks/useMediaUrl', () => ({
  useMediaUrl: (mxc: string | null | undefined) => (mxc ? `https://media.example/${mxc.split('/').pop()}` : null),
}));

afterEach(() => {
  cleanup();
  over18.value = false;
  vi.unstubAllGlobals();
});

const MXC = (id: string) => `mxc://purr.example.org/${id}`;
const pageOf = (blocks: unknown[]) => parseProfilePage({ version: 1, blocks }) as ProfilePage;
const q = (container: HTMLElement, role: string) => container.querySelector(`[data-nu-role="${role}"]`);
const qa = (container: HTMLElement, role: string) => Array.from(container.querySelectorAll(`[data-nu-role="${role}"]`));

const art = pageOf([
  {
    id: 'a',
    type: 'art',
    title: 'My art',
    albums: [
      {
        id: 'one',
        title: 'Sketches',
        pieces: [
          { url: MXC('safe'), title: 'A cat', tags: ['cats'], rating: 'general' },
          { url: MXC('spicy'), title: 'Spicy', tags: [], rating: 'mature' },
        ],
      },
    ],
  },
]);

describe('the art gallery', () => {
  it('hides Mature pieces from someone who has not said they are over 18, and says so', () => {
    const { container } = render(<PageBlocks blocks={art.blocks} />);
    expect(qa(container, 'art-piece').map((piece) => piece.getAttribute('data-nu-rating'))).toEqual(['general']);
    expect(container.innerHTML).not.toContain('spicy');
    expect(q(container, 'art-mature-hidden')?.textContent).toContain('1 Mature piece is hidden');
  });

  it('blurs Mature pieces for someone who has, until they click', () => {
    over18.value = true;
    const { container } = render(<PageBlocks blocks={art.blocks} />);
    const pieces = qa(container, 'art-piece');
    expect(pieces).toHaveLength(2);
    const mature = pieces.find((piece) => piece.getAttribute('data-nu-rating') === 'mature') as HTMLElement;
    const button = mature.querySelector('button') as HTMLButtonElement;
    expect(button.className).toContain('--blurred');
    expect(button.getAttribute('aria-label')).toContain('Mature');
    fireEvent.click(button);
    expect(mature.querySelector('button')?.className).not.toContain('--blurred');
  });

  it('keeps an album that is all Mature out of the page for someone who has not said, cover included', () => {
    const page = pageOf([
      { id: 'a', type: 'art', albums: [{ id: 'x', title: 'All mature', pieces: [{ url: MXC('m1'), rating: 'mature' }] }] },
    ]);
    const { container } = render(<PageBlocks blocks={page.blocks} />);
    expect(container.textContent).toBe('');
    expect(visiblePieces(page.blocks[0].type === 'art' ? page.blocks[0].albums[0] : (undefined as never), false)).toEqual([]);
  });

  it('puts pieces on the page only once its album is open', () => {
    const page = pageOf([
      {
        id: 'a',
        type: 'art',
        albums: [
          { id: 'x', title: 'One', pieces: [{ url: MXC('p1') }] },
          { id: 'y', title: 'Two', pieces: [{ url: MXC('p2') }] },
        ],
      },
    ]);
    const { container } = render(<PageBlocks blocks={page.blocks} />);
    expect(qa(container, 'art-piece')).toHaveLength(0);
    fireEvent.click(qa(container, 'art-album')[0].querySelector('button') as Element);
    expect(qa(container, 'art-piece')).toHaveLength(1);
  });
});

describe('the social and commission blocks without a Matrix client', () => {
  const owner = { userId: '@luna:purr.example', isMe: false };

  it('sends a visitor to sign in for the guestbook and commissions', () => {
    const page = pageOf([
      { id: 'g', type: 'guestbook' },
      { id: 'c', type: 'commissions' },
    ]);
    const { container } = render(
      <PageOwnerContext.Provider value={owner}>
        <PageBlocks blocks={page.blocks} />
      </PageOwnerContext.Provider>
    );
    expect(q(container, 'guestbook-signed-out')).not.toBeNull();
    expect(q(container, 'commissions-signed-out')).not.toBeNull();
  });

  it('shows only friends whose own pages are public', async () => {
    const page = pageOf([{ id: 'f', type: 'friends', users: ['@pub:purr.example', '@private:purr.example'] }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('pub%3Apurr') ? new Response(JSON.stringify({ userId: '@pub:purr.example', displayName: 'Pub', page: null }), { status: 200 }) : new Response('{}', { status: 404 })
      )
    );
    const { container, findByText } = render(
      <PageOwnerContext.Provider value={owner}>
        <PageBlocks blocks={page.blocks} />
      </PageOwnerContext.Provider>
    );
    await findByText('Pub');
    expect(container.textContent).not.toContain('private');
    expect(container.querySelectorAll('a[href="/@pub"]')).toHaveLength(1);
  });
});
