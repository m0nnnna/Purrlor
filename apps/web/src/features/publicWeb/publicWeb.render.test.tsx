import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PublicApp } from './PublicApp';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reply = (routes: Record<string, { status?: number; body: unknown }>) =>
  vi.fn(async (url: string) => {
    const path = url.split('?')[0];
    const hit = routes[path];
    return new Response(JSON.stringify(hit?.body ?? { code: 'not_found' }), { status: hit?.status ?? (hit ? 200 : 404) });
  });

const noop = () => undefined;
const q = (container: HTMLElement, role: string) => container.querySelector(`[data-nu-role="${role}"]`);

describe('the public web, signed out', () => {
  it('draws an opted-in page from the public API, without a Matrix client', async () => {
    vi.stubGlobal(
      'fetch',
      reply({
        '/api/public/pages/luna': {
          body: {
            userId: '@luna:purr.example',
            displayName: 'Luna',
            bio: 'hi, I draw cats',
            page: { version: 1, style: {}, blocks: [{ id: 't', type: 'text', body: 'welcome to my page' }] },
          },
        },
        '/api/public/feed': { body: { posts: [], authors: {} } },
      })
    );
    const { container } = render(<PublicApp route={{ kind: 'page', user: 'luna' }} onSignIn={noop} onRegister={noop} />);
    await waitFor(() => expect(container.textContent).toContain('welcome to my page'));
    expect(container.textContent).toContain('@luna');
    expect(container.textContent).toContain('hi, I draw cats');
    expect(q(container, 'public-make-page')).not.toBeNull();
  });

  it('runs the stored page through the parser: hostile values never reach the page', async () => {
    vi.stubGlobal(
      'fetch',
      reply({
        '/api/public/pages/evil': {
          body: {
            userId: '@evil:purr.example',
            page: {
              version: 1,
              style: { colors: { bg: 'red; background: url(//evil.example/x)' } },
              blocks: [
                { id: 'l', type: 'links', items: [{ label: 'x', url: 'javascript:alert(1)' }] },
                { id: 'h', type: 'html', body: '<script>alert(1)</script>' },
              ],
            },
          },
        },
        '/api/public/feed': { body: { posts: [], authors: {} } },
      })
    );
    const { container } = render(<PublicApp route={{ kind: 'page', user: 'evil' }} onSignIn={noop} onRegister={noop} />);
    await waitFor(() => expect(q(container, 'public-page')).not.toBeNull());
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.innerHTML).not.toContain('evil.example');
  });

  it('says "Sign in to see this page" for every page that is not shown, and offers sign-in', async () => {
    vi.stubGlobal('fetch', reply({}));
    const onSignIn = vi.fn();
    const { container } = render(<PublicApp route={{ kind: 'page', user: 'nobody' }} onSignIn={onSignIn} onRegister={noop} />);
    await waitFor(() => expect(q(container, 'public-page-closed')).not.toBeNull());
    expect(container.textContent).toContain('Sign in to see this page');
    expect(container.textContent).not.toContain('@nobody');
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' })[1]);
    expect(onSignIn).toHaveBeenCalled();
  });

  it('shows the feed with counts only, a hidden Space repost, and sign-in prompts', async () => {
    vi.stubGlobal(
      'fetch',
      reply({
        '/api/public/feed': {
          body: {
            posts: [
              { eventId: '$a', author: '@luna:purr.example', ts: Date.now() - 60_000, body: 'hello world', likes: 3, comments: 2 },
              { eventId: '$b', author: '@bob:purr.example', ts: Date.now() - 120_000, body: '', repost: { kind: 'hidden' } },
            ],
            authors: { '@luna:purr.example': { userId: '@luna:purr.example' } },
          },
        },
      })
    );
    const { container } = render(<PublicApp route={{ kind: 'feed' }} onSignIn={noop} onRegister={noop} />);
    await waitFor(() => expect(container.textContent).toContain('hello world'));
    expect(container.textContent).toContain('Shared a post from a Space. Sign in to see it.');
    expect(container.textContent).toContain('3');
    expect(screen.getAllByText('Sign in to like or comment')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Join Purrlor' }).length).toBeGreaterThan(0);
    // The author's name leads to their page, which says for itself whether it's shown.
    expect(container.querySelector('a[href="/@luna"]')).not.toBeNull();
    expect(container.querySelector('a[href="/@luna/post/%24a"]')).not.toBeNull();
  });

  it('shows one post at its own address', async () => {
    vi.stubGlobal(
      'fetch',
      reply({
        '/api/public/posts/%24a': {
          body: { posts: [{ eventId: '$a', author: '@luna:purr.example', ts: Date.now(), body: 'just this one' }], authors: {} },
        },
      })
    );
    const { container } = render(
      <PublicApp route={{ kind: 'post', user: 'luna', eventId: '$a' }} onSignIn={noop} onRegister={noop} />
    );
    await waitFor(() => expect(container.textContent).toContain('just this one'));
  });
});
