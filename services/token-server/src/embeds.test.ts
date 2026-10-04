import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isBlockedAddress, urlProblem } from './embedGuard.js';
import { FetchRefused, fakeFetchesForTests, guardedGet, guardedLookup, type Fetched, type FetchOptions } from './embedFetch.js';
import { decodePage, plainText, readPageMeta } from './embedHtml.js';
import { findProvider, readTweetHtml } from './embedProviders.js';
import { EmbedCache, FileStore, embedFiles, resolveUncached } from './embedResolve.js';

describe('the guard', () => {
  it('refuses private, loopback, link-local and other inner addresses', () => {
    for (const address of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::10.0.0.1',
      '2002:a00:1::', 'not an address',
    ]) {
      assert.equal(isBlockedAddress(address), true, address);
    }
  });

  it('allows public ones', () => {
    for (const address of ['93.184.216.34', '172.32.0.1', '8.8.8.8', '2606:4700:4700::1111', '::ffff:93.184.216.34']) {
      assert.equal(isBlockedAddress(address), false, address);
    }
  });

  it('refuses URLs that point inward or aren’t plain web links', () => {
    for (const url of [
      'ftp://example.com/x', 'file:///etc/passwd', 'http://localhost/', 'http://matrix:8008/', 'http://token-server/', 'http://127.0.0.1/',
      'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'https://user:pw@example.com/', 'https://example.com:6167/',
      'http://router.lan/', 'http://printer.local/', 'nonsense',
    ]) {
      assert.ok(urlProblem(url), url);
    }
    for (const url of ['https://example.com/', 'http://example.com:8080/x', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ']) {
      assert.equal(urlProblem(url), undefined, url);
    }
  });

  it('checks what a name resolves to when connecting, so a public-looking name can’t lead inward', async () => {
    // 'localhost' stands in for any name whose DNS answers with a private address.
    const err = await new Promise((resolve) => (guardedLookup as unknown as (h: string, o: object, cb: (e: unknown) => void) => void)('localhost', { all: true }, resolve));
    assert.ok(err instanceof FetchRefused);
  });

  it('never connects to a local server, even by its address', async () => {
    const server = createServer((_req, res) => res.end('<title>secret</title>'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    after(() => server.close());
    const { port } = server.address() as AddressInfo;
    await assert.rejects(guardedGet(`http://127.0.0.1:${port}/`, { limitFor: () => 1000 }), FetchRefused);
  });
});

describe('reading a page', () => {
  const page = `<!doctype html><html><head>
    <meta charset="utf-8"><title>Fallback &amp; title</title>
    <meta property="og:title" content="Cats &amp; dogs">
    <meta property='og:description' content="A page about &quot;pets&quot;">
    <meta property="og:image" content="/pics/cat.jpg">
    <meta property="og:image" content="/pics/second.jpg">
    <meta property="og:site_name" content="Pet News">
    <meta name="theme-color" content="#FFAA00">
    <meta property="og:restrictions:age" content="18+">
    </head><body><meta property="og:title" content="not this"></body></html>`;

  it('takes OpenGraph first, the first of each tag, decoded', () => {
    const meta = readPageMeta(page);
    assert.equal(meta.title, 'Cats & dogs');
    assert.equal(meta.description, 'A page about "pets"');
    assert.equal(meta.image, '/pics/cat.jpg');
    assert.equal(meta.siteName, 'Pet News');
    assert.equal(meta.color, '#ffaa00');
    assert.equal(meta.adult, true);
  });

  it('falls back to the <title> and plain description', () => {
    const meta = readPageMeta('<head><title> Just a\n title </title><meta name="description" content="Plain."></head>');
    assert.equal(meta.title, 'Just a title');
    assert.equal(meta.description, 'Plain.');
    assert.equal(meta.adult, false);
  });

  it('decodes a page in the charset it declares', () => {
    const latin1 = Buffer.from('<head><meta charset="iso-8859-1"><title>Caf\xe9</title></head>', 'latin1');
    assert.equal(readPageMeta(decodePage(latin1, 'text/html')).title, 'Café');
  });

  it('turns HTML into plain text', () => {
    assert.equal(plainText('<p>Hello <b>there</b><br>second &amp; line</p><script>alert(1)</script>'), 'Hello there\nsecond & line');
  });
});

describe('providers', () => {
  const id = (url: string) => {
    const found = findProvider(new URL(url));
    return found && { provider: found.provider.name, ...found.params };
  };

  it('knows players by their links', () => {
    assert.deepEqual(id('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), { provider: 'youtube', id: 'dQw4w9WgXcQ' });
    assert.deepEqual(id('https://youtu.be/dQw4w9WgXcQ'), { provider: 'youtube', id: 'dQw4w9WgXcQ' });
    assert.deepEqual(id('https://youtube.com/shorts/dQw4w9WgXcQ'), { provider: 'youtube', id: 'dQw4w9WgXcQ' });
    assert.deepEqual(id('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), { provider: 'youtube', id: 'dQw4w9WgXcQ' });
    assert.deepEqual(id('https://vimeo.com/76979871'), { provider: 'vimeo', id: '76979871' });
    assert.deepEqual(id('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC'), { provider: 'spotify', id: 'track/4uLU6hMCjMI75M1A2tKUQC' });
    assert.deepEqual(id('https://soundcloud.com/artist/a-song'), { provider: 'soundcloud', id: 'artist/a-song' });
    assert.deepEqual(id('https://soundcloud.com/artist/sets/an-album'), { provider: 'soundcloud', id: 'artist/sets/an-album' });
    assert.deepEqual(id('https://clips.twitch.tv/FunnyClipName-abc'), { provider: 'twitch-clip', id: 'FunnyClipName-abc' });
    assert.deepEqual(id('https://www.twitch.tv/videos/123456'), { provider: 'twitch-video', id: '123456' });
    assert.equal(id('https://www.youtube.com/watch?v=short'), undefined);
  });

  it('knows posts by their links', () => {
    assert.deepEqual(id('https://x.com/someone/status/1234567890'), { provider: 'x', user: 'someone', id: '1234567890' });
    assert.deepEqual(id('https://twitter.com/someone/status/1234567890'), { provider: 'x', user: 'someone', id: '1234567890' });
    assert.deepEqual(id('https://bsky.app/profile/alice.bsky.social/post/3k2a4b5c6d7e8'), { provider: 'bluesky', actor: 'alice.bsky.social', rkey: '3k2a4b5c6d7e8' });
    assert.deepEqual(id('https://mastodon.social/@Gargron/109240987658744444'), { provider: 'mastodon', id: '109240987658744444' });
    assert.deepEqual(id('https://www.reddit.com/r/cats/comments/abc123/a_cat/'), { provider: 'reddit', id: 'abc123' });
    assert.equal(id('https://example.com/some/page'), undefined);
  });

  it('reads a tweet’s text and date from X’s oEmbed blockquote', () => {
    const html =
      '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Hello &amp; welcome<br>to the <a href="https://t.co/x">thing</a></p>&mdash; Someone (@someone) <a href="https://twitter.com/someone/status/1">October 4, 2026</a></blockquote>';
    const tweet = readTweetHtml(html);
    assert.equal(tweet.text, 'Hello & welcome\nto the thing');
    assert.equal(tweet.published, Date.parse('October 4, 2026'));
  });
});

describe('FileStore', () => {
  it('keeps files for a while under unguessable IDs, within a total size', () => {
    const store = new FileStore(1000, 10);
    const a = store.put(Buffer.from('12345'), 'image/png', 0);
    assert.match(a.id, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(store.get(a.id, 500)?.mimetype, 'image/png');
    const b = store.put(Buffer.from('1234567'), 'image/png', 600);
    assert.equal(store.get(a.id, 600), undefined, 'the oldest goes to make room');
    assert.equal(store.get(b.id, 1700), undefined, 'and every file goes in time');
  });
});

describe('EmbedCache', () => {
  it('fetches a link once while the answer is fresh', async () => {
    let calls = 0;
    const cache = new EmbedCache(async () => {
      calls++;
      return { embed: { url: 'u', kind: 'card', title: 't' }, files: {} };
    });
    await Promise.all([cache.get('u', 0), cache.get('u', 0)]);
    await cache.get('u', 60_000);
    assert.equal(calls, 1);
    await cache.get('u', 15 * 60_000);
    assert.equal(calls, 2);
  });
});

describe('resolving', () => {
  const pages = new Map<string, Partial<Fetched>>();
  let restore = () => {};
  before(() => {
    restore = fakeFetchesForTests(fakeFetch);
  });
  after(() => restore());
  const fakeFetch = async (url: string, options: FetchOptions): Promise<Fetched> => {
    const page = pages.get(url);
    if (!page) return { url, status: 404, contentType: 'text/html', body: Buffer.alloc(0), truncated: false };
    const body = page.body ?? Buffer.alloc(0);
    const limit = options.limitFor(page.contentType ?? '');
    return { url, status: 200, contentType: page.contentType ?? '', body: body.subarray(0, Math.max(0, limit)), truncated: body.length > limit };
  };
  const html = (text: string): Partial<Fetched> => ({ contentType: 'text/html; charset=utf-8', body: Buffer.from(text) });
  const png = Buffer.from('89504e470d0a1a0a', 'hex');

  it('makes a card from a page’s OpenGraph, with its picture as a file', async () => {
    pages.set('https://news.example/story', html('<head><meta property="og:title" content="Big news"><meta property="og:image" content="/p.png"></head>'));
    pages.set('https://news.example/p.png', { contentType: 'image/png', body: png });
    const result = await resolveUncached('https://news.example/story');
    assert.equal(result?.embed.kind, 'card');
    assert.equal(result?.embed.title, 'Big news');
    assert.deepEqual(result?.embed.site, { name: 'news.example' });
    assert.equal(result?.files.image?.mimetype, 'image/png');
    assert.deepEqual(embedFiles.get(result!.files.image!.id)?.bytes, png);
  });

  it('gives nothing for a page without a title', async () => {
    pages.set('https://blank.example/', html('<head></head><body>hi</body>'));
    assert.equal(await resolveUncached('https://blank.example/'), undefined);
  });

  it('makes a direct image link the image, and a too-big video a card naming it', async () => {
    pages.set('https://cdn.example/cat.gif', { contentType: 'image/gif', body: png });
    const gif = await resolveUncached('https://cdn.example/cat.gif');
    assert.equal(gif?.embed.kind, 'image');
    assert.equal(gif?.files.image?.mimetype, 'image/gif');

    pages.set('https://cdn.example/huge.mp4', { contentType: 'video/mp4', body: Buffer.alloc(26 * 1024 * 1024) });
    const huge = await resolveUncached('https://cdn.example/huge.mp4');
    assert.equal(huge?.embed.kind, 'card');
    assert.equal(huge?.embed.title, 'huge.mp4');
  });

  it('never hands back a type a browser would run', async () => {
    pages.set('https://evil.example/x.svg', { contentType: 'image/svg+xml', body: Buffer.from('<svg onload="alert(1)"/>') });
    assert.equal(await resolveUncached('https://evil.example/x.svg'), undefined);
    pages.set('https://evil.example/story', html('<head><meta property="og:title" content="Hi"><meta property="og:image" content="/x.svg"></head>'));
    assert.equal((await resolveUncached('https://evil.example/story'))?.files.image, undefined);
  });

  it('makes a YouTube link a player from its oEmbed', async () => {
    pages.set('https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ', {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ title: 'Never Gonna Give You Up', author_name: 'Rick Astley', author_url: 'https://www.youtube.com/@RickAstleyYT' })),
    });
    pages.set('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', { contentType: 'image/jpeg', body: png });
    const result = await resolveUncached('https://youtu.be/dQw4w9WgXcQ');
    assert.equal(result?.embed.kind, 'player');
    assert.deepEqual(result?.embed.player, { provider: 'youtube', id: 'dQw4w9WgXcQ' });
    assert.equal(result?.embed.url, 'https://youtu.be/dQw4w9WgXcQ');
    assert.equal(result?.embed.title, 'Never Gonna Give You Up');
    assert.deepEqual(result?.embed.author, { name: 'Rick Astley', url: 'https://www.youtube.com/@RickAstleyYT' });
    assert.ok(result?.files.image);
  });

  it('makes a Bluesky link a post from the public API', async () => {
    const uri = encodeURIComponent('at://alice.bsky.social/app.bsky.feed.post/3k2a');
    pages.set(`https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?depth=0&parentHeight=0&uri=${uri}`, {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({
          thread: {
            post: {
              author: { handle: 'alice.bsky.social', displayName: 'Alice', avatar: 'https://cdn.bsky.app/a.jpg' },
              record: { text: 'hello from bluesky', createdAt: '2026-10-04T12:00:00Z' },
              labels: [{ val: 'nudity' }],
            },
          },
        })
      ),
    });
    pages.set('https://cdn.bsky.app/a.jpg', { contentType: 'image/jpeg', body: png });
    const result = await resolveUncached('https://bsky.app/profile/alice.bsky.social/post/3k2a');
    assert.equal(result?.embed.kind, 'post');
    assert.equal(result?.embed.description, 'hello from bluesky');
    assert.deepEqual(result?.embed.author, { name: 'Alice', handle: '@alice.bsky.social', url: 'https://bsky.app/profile/alice.bsky.social' });
    assert.equal(result?.embed.published, Date.parse('2026-10-04T12:00:00Z'));
    assert.equal(result?.embed.sensitive, true);
    assert.ok(result?.files.avatar);
  });

  it('falls back to the page when a site’s API has nothing', async () => {
    pages.set('https://www.reddit.com/r/cats/comments/zz9/a_cat/', html('<head><meta property="og:title" content="A cat"></head>'));
    const result = await resolveUncached('https://www.reddit.com/r/cats/comments/zz9/a_cat/');
    assert.equal(result?.embed.kind, 'card');
    assert.equal(result?.embed.title, 'A cat');
    assert.equal(result?.embed.site?.name, 'Reddit');
  });

  it('refuses a link the guard won’t fetch', async () => {
    await assert.rejects(resolveUncached('http://localhost/'), FetchRefused);
  });
});
