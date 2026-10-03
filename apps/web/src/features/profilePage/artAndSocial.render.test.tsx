import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createContext } from 'react';
import { parseProfilePage, type ProfilePage } from '../../matrix/profilePage';
import { PageBlocks } from './PageBlocks';
import { PageOwnerContext } from './PageOwnerContext';
import { PageTargetContext } from './PageTargetContext';
import { visiblePieces } from './GalleryBlock';

const viewer = vi.hoisted(() => ({ signedIn: false }));
vi.mock('../../matrix/hooks/useSignedIn', () => ({ useSignedIn: () => viewer.signedIn }));
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
  viewer.signedIn = false;
  vi.unstubAllGlobals();
});

const MXC = (id: string) => `mxc://purr.example.org/${id}`;
const pageOf = (blocks: unknown[]) => parseProfilePage({ version: 1, blocks }) as ProfilePage;
const q = (container: HTMLElement, role: string) => container.querySelector(`[data-nu-role="${role}"]`);
const qa = (container: HTMLElement, role: string) => Array.from(container.querySelectorAll(`[data-nu-role="${role}"]`));

const art = pageOf([
  {
    id: 'a',
    type: 'gallery',
    ratings: true,
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

const drawOpen = (page: ProfilePage) => render(<PageBlocks blocks={page.blocks} openIds={page.blocks.map((b) => b.id)} />);
// An album opens over the page, outside the page's own element.
const pieces = () => qa(document.body, 'art-piece');
const openAlbum = (container: HTMLElement, index = 0) => fireEvent.click(qa(container, 'art-album-open')[index]);

describe('the gallery with ratings on', () => {
  it('hides Mature pieces from someone signed out, and says so', () => {
    const { container } = drawOpen(art);
    expect(container.innerHTML).not.toContain('spicy');
    openAlbum(container);
    expect(pieces().map((piece) => piece.getAttribute('data-nu-rating'))).toEqual(['general']);
    expect(document.body.innerHTML).not.toContain('spicy');
    expect(q(document.body, 'art-mature-hidden')?.textContent).toContain('1 Mature piece is hidden');
  });

  it('blurs Mature pieces for someone signed in, until they click', () => {
    viewer.signedIn = true;
    const { container } = drawOpen(art);
    openAlbum(container);
    expect(pieces()).toHaveLength(2);
    const mature = pieces().find((piece) => piece.getAttribute('data-nu-rating') === 'mature') as HTMLElement;
    const button = mature.querySelector('button') as HTMLButtonElement;
    expect(button.className).toContain('--blurred');
    expect(button.getAttribute('aria-label')).toContain('Mature');
    fireEvent.click(button);
    expect(mature.querySelector('button')?.className).not.toContain('--blurred');
  });

  it('keeps an album that is all Mature out of the page for someone who has not said, cover included', () => {
    const page = pageOf([
      { id: 'a', type: 'gallery', ratings: true, albums: [{ id: 'x', title: 'All mature', pieces: [{ url: MXC('m1'), rating: 'mature' }] }] },
    ]);
    const { container } = drawOpen(page);
    expect(qa(container, 'art-album')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('m1');
    expect(visiblePieces(page.blocks[0].type === 'gallery' ? page.blocks[0].albums[0] : (undefined as never), false)).toEqual([]);
  });
});

describe('the gallery on the page', () => {
  const big = pageOf([
    {
      id: 'a',
      type: 'gallery',
      albums: [
        { id: 'x', title: 'One', pieces: Array.from({ length: 9 }, (_, i) => ({ url: MXC(`p${i}`) })) },
        { id: 'y', title: 'Two', pieces: [{ url: MXC('q1') }] },
      ],
    },
  ]);

  it('loads nothing while its module is closed', () => {
    const { container } = render(<PageBlocks blocks={big.blocks} />);
    expect(q(container, 'profile-page-module-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('img')).toBeNull();
    fireEvent.click(q(container, 'profile-page-module-toggle') as Element);
    expect(qa(container, 'art-album')).toHaveLength(2);
  });

  it('shows each album as a strip of at most four thumbnails and how many there are, the pieces only once opened', () => {
    const { container } = drawOpen(big);
    const [one, two] = qa(container, 'art-album');
    expect(one.querySelectorAll('.nu-profile-page__strip-thumb')).toHaveLength(4);
    expect(two.querySelectorAll('.nu-profile-page__strip-thumb')).toHaveLength(1);
    expect(q(one as HTMLElement, 'art-album-open')?.textContent).toBe('View all (9)');
    expect(pieces()).toHaveLength(0);
    openAlbum(container);
    expect(pieces()).toHaveLength(9);
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
        <PageBlocks blocks={page.blocks} openIds={page.blocks.map((b) => b.id)} />
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
        <PageBlocks blocks={page.blocks} openIds={page.blocks.map((b) => b.id)} />
      </PageOwnerContext.Provider>
    );
    await findByText('Pub');
    expect(container.textContent).not.toContain('private');
    expect(container.querySelectorAll('a[href="/@pub"]')).toHaveLength(1);
  });
});

describe('links to the gallery', () => {
  const page = pageOf([
    {
      id: 'g',
      type: 'gallery',
      albums: [
        { id: 'x', title: 'One', pieces: [{ url: MXC('p1') }] },
        { id: 'y', title: 'Two', pieces: [{ url: MXC('p2'), title: 'Fox' }, { url: MXC('p3') }] },
      ],
    },
  ]);
  const draw = (target?: Parameters<typeof PageTargetContext.Provider>[0]['value']) =>
    render(
      <PageOwnerContext.Provider value={{ userId: '@luna:purr.example.org', isMe: false }}>
        <PageTargetContext.Provider value={target}>
          <PageBlocks blocks={page.blocks} openIds={page.blocks.map((b) => b.id)} />
        </PageTargetContext.Provider>
      </PageOwnerContext.Provider>
    );

  it('gives each album and each piece a link of its own', () => {
    const { container } = draw();
    openAlbum(container, 1);
    const links = (role: string) => qa(document.body, role).map((el) => (el as HTMLElement).dataset.nuLink);
    expect(links('art-album-link')).toContain(`${window.location.origin}/@luna/art/y`);
    expect(links('art-piece-link')).toEqual([`${window.location.origin}/@luna/art/y/1`, `${window.location.origin}/@luna/art/y/2`]);
  });

  it('opens the album a link points at, with its piece shown large', () => {
    draw({ kind: 'art', album: 'y', piece: 2 });
    expect(pieces()).toHaveLength(2);
    const lightbox = document.querySelector('.nu-lightbox img, [data-nu-role="lightbox"] img') as HTMLImageElement | null;
    expect(lightbox?.getAttribute('src')).toBe('https://media.example/p3');
  });
});
