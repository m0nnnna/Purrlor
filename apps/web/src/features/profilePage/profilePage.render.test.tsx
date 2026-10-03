import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { parseProfilePage, type ProfilePage } from '../../matrix/profilePage';
import { PageBlocks } from './PageBlocks';
import { ProfilePageLayout } from './ProfilePageLayout';
import { ProfilePageFrame } from './ProfilePageFrame';

const mx = vi.hoisted(() => ({ getUserId: () => '@me:purr.example.org', getRoom: () => null, joinRoom: () => undefined }));
vi.mock('../../matrix/MatrixClientContext', async () => {
  const { createContext } = await import('react');
  return { MatrixClientContext: createContext(mx), useMatrixClient: () => mx };
});
// Media resolves straight to an https URL, standing in for the homeserver's.
vi.mock('../../matrix/hooks/useMediaUrl', () => ({
  useMediaUrl: (mxc: string | null | undefined) => (mxc ? `https://purr.example.org/media/${mxc.split('/').pop()}` : null),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const MXC = 'mxc://purr.example.org/abc';
const q = (container: HTMLElement, role: string) => container.querySelector(`[data-nu-role="${role}"]`);
const pageOf = (raw: Record<string, unknown>) => parseProfilePage({ version: 1, ...raw }) as ProfilePage;

describe('profile page rendering', () => {
  it('opens link buttons in a new tab with no way back into Purrlor, and shows where they go', () => {
    const page = pageOf({ blocks: [{ id: 'l', type: 'links', items: [{ label: 'My art', url: 'https://www.example.art/gallery' }] }] });
    const { container } = render(<PageBlocks blocks={page.blocks} openIds={page.blocks.map((b) => b.id)} />);
    const link = q(container, 'profile-page-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://www.example.art/gallery');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(link.rel).toContain('noreferrer');
    expect(link.textContent).toContain('example.art');
  });

  it('plays the profile song in a floating window, loading nothing until play is pressed', () => {
    const page = pageOf({ blocks: [{ id: 's', type: 'song', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }] });
    render(<ProfilePageLayout page={page} header={null} posts={null} />);
    const song = q(document.body, 'profile-song') as HTMLElement;
    expect(song).not.toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    fireEvent.click(q(song, 'profile-page-play') as Element);
    expect(song.querySelector('iframe')?.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1');
  });

  it('puts modules in the column their owner chose, each closed to its title', () => {
    const page = pageOf({
      blocks: [
        { id: 't', type: 'text', title: 'Hello', body: 'hi', side: 'right' },
        { id: 'l', type: 'links', items: [{ label: 'Site', url: 'https://example.org' }] },
      ],
    });
    const { container } = render(<ProfilePageLayout page={page} header={<p>header</p>} posts={<p>posts</p>} />);
    const left = q(container, 'profile-page-left') as HTMLElement;
    expect(left.textContent).toBe('Links');
    expect(q(container, 'profile-page-right')?.textContent).toBe('Hello');
    expect(container.querySelector('a')).toBeNull();
    fireEvent.click(q(left, 'profile-page-module-toggle') as Element);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.org/');
  });

  it('draws text blocks as text, never as HTML', () => {
    const page = pageOf({
      blocks: [{ id: 't', type: 'text', body: '<img src=x onerror=alert(1)> hi', formatted: '<script>alert(1)</script>' }],
    });
    const { container } = render(<PageBlocks blocks={page.blocks} openIds={page.blocks.map((b) => b.id)} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[onerror]')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)> hi');
  });

  it('puts the page style on its own frame as variables, and nothing without a page', () => {
    const page = pageOf({
      style: { colors: { bg: '#112233', text: '#ffffff' }, background: { kind: 'image', url: MXC, fit: 'tile' }, columns: 2 },
    });
    const { container, rerender } = render(
      <ProfilePageFrame page={page}>
        <p>inside</p>
      </ProfilePageFrame>
    );
    const frame = q(container, 'profile-page') as HTMLElement;
    expect(frame.style.getPropertyValue('--page-bg')).toBe('#112233');
    expect(frame.style.getPropertyValue('--page-text')).toBe('#ffffff');
    expect(frame.style.backgroundImage).toContain('https://purr.example.org/media/abc');

    rerender(
      <ProfilePageFrame page={undefined}>
        <p>inside</p>
      </ProfilePageFrame>
    );
    expect(q(container, 'profile-page')).toBeNull();
    expect(container.textContent).toBe('inside');
  });

  it('a hostile page draws as a plain one', () => {
    const page = pageOf({
      style: {
        colors: { bg: 'red;} body{display:none' },
        background: { kind: 'image', url: 'https://evil.example/x.png' },
        fonts: { body: "x'; }" },
      },
      blocks: [{ id: 'i', type: 'image', url: 'javascript:alert(1)' }],
    });
    const { container } = render(
      <ProfilePageFrame page={page}>
        <PageBlocks blocks={page.blocks} openIds={page.blocks.map((b) => b.id)} />
      </ProfilePageFrame>
    );
    const frame = q(container, 'profile-page') as HTMLElement;
    expect(frame.style.getPropertyValue('--page-bg')).toBe('#0d0a13');
    expect(frame.style.backgroundImage).toBe('');
    expect(container.innerHTML).not.toContain('evil.example');
    expect(container.innerHTML).not.toContain('javascript:');
  });

  it('lets a visitor turn effects off, and remembers it', () => {
    const page = pageOf({ style: { effect: 'snow' } });
    const { container, unmount } = render(<ProfilePageFrame page={page}>x</ProfilePageFrame>);
    expect(q(container, 'profile-page-effects')).not.toBeNull();
    fireEvent.click(q(container, 'profile-page-effects-toggle') as Element);
    expect(q(container, 'profile-page-effects')).toBeNull();
    unmount();
    const again = render(<ProfilePageFrame page={page}>x</ProfilePageFrame>);
    expect(q(again.container, 'profile-page-effects')).toBeNull();
  });
});
