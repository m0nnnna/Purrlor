import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { MatrixClient } from 'matrix-js-sdk';
import { MatrixClientContext } from '../../matrix/MatrixClientContext';
import type { StoredEmbed } from '../../matrix/embeds';
import { EmbedList } from './EmbedCard';

function fakeClient(settings: Record<string, unknown> = {}): MatrixClient {
  return {
    getAccountData: (type: string) => (type === 'xyz.nekous.embed_settings' ? { getContent: () => settings } : undefined),
    on: () => undefined,
    removeListener: () => undefined,
  } as unknown as MatrixClient;
}

const video = (id: string): StoredEmbed => ({
  url: `https://www.youtube.com/watch?v=${id}`,
  kind: 'player',
  title: `Video ${id}`,
  site: { name: 'YouTube', color: '#ff0000' },
  player: { provider: 'youtube', id },
});

function renderEmbeds(embeds: StoredEmbed[], settings?: Record<string, unknown>, signedIn = true) {
  const list = <EmbedList embeds={embeds} eventKey="$event" />;
  return render(signedIn ? <MatrixClientContext.Provider value={fakeClient(settings)}>{list}</MatrixClientContext.Provider> : list);
}

afterEach(cleanup);

describe('EmbedList', () => {
  it('loads nothing from a player’s site until it’s pressed, then only one plays at a time', () => {
    const view = renderEmbeds([video('aaaaaaaaaaa'), video('bbbbbbbbbbb')]);
    expect(view.container.querySelector('iframe')).toBeNull();
    const [first, second] = view.getAllByRole('button', { name: /Play/ });
    fireEvent.click(first);
    let frames = view.container.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    expect(frames[0].getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/aaaaaaaaaaa?autoplay=1');
    fireEvent.click(second);
    frames = view.container.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    expect(frames[0].getAttribute('src')).toContain('bbbbbbbbbbb');
  });

  it('draws players as cards that open the site under "no players", and signed out', () => {
    for (const draw of [() => renderEmbeds([video('aaaaaaaaaaa')], { show: 'no-players' }), () => renderEmbeds([video('ccccccccccc')], undefined, false)]) {
      const view = draw();
      expect(view.queryByRole('button', { name: /Play/ })).toBeNull();
      expect(view.container.querySelector('a.nu-embed__body')?.getAttribute('href')).toMatch(/^https:\/\/www\.youtube\.com\/watch/);
      cleanup();
    }
  });

  it('draws nothing under "plain links"', () => {
    const view = renderEmbeds([video('aaaaaaaaaaa')], { show: 'none' });
    expect(view.container.querySelector('[data-nu-role="embed"]')).toBeNull();
  });

  it('keeps a sensitive embed covered until asked, and shows text as text', () => {
    const view = renderEmbeds([{ url: 'https://x.example', kind: 'post', description: '<img src=x onerror=alert(1)>', sensitive: true, author: { name: 'Someone' } }]);
    const embed = view.container.querySelector('[data-nu-role="embed"]')!;
    expect(embed.className).toContain('nu-embed--covered');
    expect(embed.querySelector('img')).toBeNull();
    expect(embed.textContent).toContain('<img src=x onerror=alert(1)>');
    fireEvent.click(view.getByRole('button', { name: /Sensitive/ }));
    expect(embed.className).not.toContain('nu-embed--covered');
  });

  it('offers a remove button only when asked to', () => {
    let removed = '';
    const view = render(
      <MatrixClientContext.Provider value={fakeClient()}>
        <EmbedList embeds={[{ url: 'https://x.example', kind: 'card', title: 'X' }]} eventKey="$e" onRemove={(url) => (removed = url)} />
      </MatrixClientContext.Provider>
    );
    fireEvent.click(view.getByRole('button', { name: 'Remove this embed' }));
    expect(removed).toBe('https://x.example');
  });
});
