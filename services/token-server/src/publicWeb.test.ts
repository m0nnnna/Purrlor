import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addRoomMedia,
  collectMxc,
  isSeekableMediaType,
  isServableMediaType,
  linkCardHtml,
  localUserId,
  mayServeMedia,
  MediaIndex,
  pageMedia,
  pageOfPosts,
  parseRange,
  publicPageContent,
  readFollows,
  type AdminLists,
  type MediaSource,
  parseHiddenList,
  publicPostsFromTimeline,
  readEmotes,
  readPageContent,
  readProfileOwner,
  readPublicWeb,
  type PublicPost,
  type RawEvent,
} from './publicWeb.js';

const OWNER = '@luna:purr.example';
const ROOM_STATE: RawEvent[] = [
  { type: 'm.room.create', state_key: '', sender: OWNER, content: { creator: OWNER, type: 'xyz.nekous.profile' } },
  { type: 'xyz.nekous.feed', state_key: '', sender: OWNER, content: { owner: OWNER, profile: true } },
];

const post = (id: string, ts: number, content: Record<string, unknown>, sender = OWNER): RawEvent => ({
  type: 'xyz.nekous.post',
  event_id: id,
  sender,
  origin_server_ts: ts,
  content,
});

describe('who and what is public', () => {
  it('only takes users on this homeserver', () => {
    assert.equal(localUserId('@luna', 'purr.example'), '@luna:purr.example');
    assert.equal(localUserId('Luna', 'purr.example'), '@luna:purr.example');
    assert.equal(localUserId('@luna:purr.example', 'purr.example'), '@luna:purr.example');
    assert.equal(localUserId('@luna:elsewhere.example', 'purr.example'), undefined);
    assert.equal(localUserId('../../admin', 'purr.example'), undefined);
    assert.equal(localUserId('', 'purr.example'), undefined);
  });

  it('trusts a profile room only when its creator is the owner it names', () => {
    assert.equal(readProfileOwner(ROOM_STATE), OWNER);
    const forged = [ROOM_STATE[0], { ...ROOM_STATE[1], content: { owner: '@admin:purr.example' } }];
    assert.equal(readProfileOwner(forged), undefined);
    // A room that isn't a profile room isn't read as one, whatever its marker says.
    const notProfile = [{ ...ROOM_STATE[0], content: { creator: OWNER } }, ROOM_STATE[1]];
    assert.equal(readProfileOwner(notProfile), undefined);
  });

  it('shows a page only when its owner opted in, and only a page that is one', () => {
    assert.equal(readPublicWeb(ROOM_STATE), false);
    assert.equal(readPublicWeb([...ROOM_STATE, { type: 'xyz.nekous.public_web', state_key: '', content: { enabled: 'yes' } }]), false);
    assert.equal(readPublicWeb([...ROOM_STATE, { type: 'xyz.nekous.public_web', state_key: '', content: { enabled: true } }]), true);
    assert.equal(readPageContent([{ type: 'xyz.nekous.profile_page', state_key: '', content: {} }]), undefined);
    assert.deepEqual(readPageContent([{ type: 'xyz.nekous.profile_page', state_key: '', content: { version: 1, blocks: [] } }]), {
      version: 1,
      blocks: [],
    });
  });
});

describe('publicPostsFromTimeline', () => {
  it('keeps the owner’s posts, newest first, with only what a signed-out reader may see', () => {
    const posts = publicPostsFromTimeline(
      [
        post('$1', 1000, {
          body: 'hi @Alice :cat:',
          formatted_body:
            'hi <a href="https://matrix.to/#/@alice:purr.example">Alice</a> <img data-mx-emoticon src="mxc://purr.example/cat" alt=":cat:" title=":cat:" height="32" />',
          'm.mentions': { user_ids: ['@alice:purr.example'] },
        }),
        post('$2', 2000, { body: 'second' }),
      ],
      OWNER
    );
    assert.deepEqual(
      posts.map((p) => p.eventId),
      ['$2', '$1']
    );
    const first = posts[1];
    assert.deepEqual(first.emotes, [{ shortcode: 'cat', url: 'mxc://purr.example/cat' }]);
    // Mention links (and the IDs in them) don't travel.
    assert.ok(!JSON.stringify(first).includes('@alice:purr.example'));
    assert.ok(!('formatted_body' in first));
  });

  it('ignores posts by anyone but the owner, redacted posts, and edits by others', () => {
    const posts = publicPostsFromTimeline(
      [
        post('$a', 1, { body: 'mine' }),
        post('$b', 2, { body: 'squatter' }, '@mallory:purr.example'),
        { ...post('$c', 3, {}), unsigned: { redacted_because: {} } },
        post('$e1', 4, { 'm.new_content': { body: 'hijacked' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$a' } }, '@mallory:purr.example'),
      ],
      OWNER
    );
    assert.deepEqual(
      posts.map((p) => [p.eventId, p.body]),
      [['$a', 'mine']]
    );
  });

  it('applies the owner’s newest edit', () => {
    const posts = publicPostsFromTimeline(
      [
        post('$a', 1, { body: 'first' }),
        post('$e1', 2, { 'm.new_content': { body: 'second' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$a' } }),
        post('$e2', 3, { 'm.new_content': { body: 'third' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$a' } }),
      ],
      OWNER
    );
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body, 'third');
    assert.equal(posts[0].edited, true);
  });

  it('counts likes once per person and comments, without saying who', () => {
    const like = (sender: string, id: string): RawEvent => ({
      type: 'm.reaction',
      event_id: id,
      sender,
      content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$a', key: '❤️' } },
    });
    const comment: RawEvent = {
      type: 'xyz.nekous.comment',
      event_id: '$c1',
      sender: '@bob:purr.example',
      content: { body: 'secret comment', 'm.relates_to': { rel_type: 'm.reference', event_id: '$a' } },
    };
    const [result] = publicPostsFromTimeline([post('$a', 1, { body: 'x' }), like('@bob:x', '$l1'), like('@bob:x', '$l2'), like('@cat:x', '$l3'), comment], OWNER);
    assert.equal(result.likes, 2);
    assert.equal(result.comments, 1);
    assert.ok(!JSON.stringify(result).includes('secret comment'));
    assert.ok(!JSON.stringify(result).includes('@bob'));
  });

  it('hides what a Space post said when it was reposted or quoted to Global', () => {
    const fromSpace = {
      roomId: '!feed:purr.example',
      eventId: '$orig',
      sender: '@bob:purr.example',
      senderName: 'Bob',
      origin: { kind: 'space', spaceId: '!space:purr.example', spaceName: 'Secret Club' },
      ts: 5,
      body: 'members only',
      attachments: [{ kind: 'image', url: 'mxc://purr.example/private', info: { mimetype: 'image/png' } }],
    };
    const [quote] = publicPostsFromTimeline([post('$q', 1, { body: 'look at this', 'xyz.nekous.repost_of': fromSpace })], OWNER);
    assert.equal(quote.body, 'look at this');
    assert.deepEqual(quote.repost, { kind: 'hidden' });
    const text = JSON.stringify(quote);
    for (const secret of ['members only', 'Secret Club', '@bob', 'private', '!space']) assert.ok(!text.includes(secret), secret);
  });

  it('shows a repost of a Global post with its author', () => {
    const fromGlobal = { roomId: '!p:x', eventId: '$o', sender: '@bob:purr.example', origin: { kind: 'global' }, ts: 5, body: 'hello world' };
    const [repost] = publicPostsFromTimeline([post('$r', 1, { body: '', 'xyz.nekous.repost_of': fromGlobal })], OWNER);
    assert.deepEqual(repost.repost, { kind: 'global', author: '@bob:purr.example', ts: 5, body: 'hello world' });
  });

  it('keeps only plain image and video attachments', () => {
    const [result] = publicPostsFromTimeline(
      [
        post('$a', 1, {
          body: '',
          'xyz.nekous.attachments': [
            { kind: 'image', url: 'mxc://purr.example/ok', info: { mimetype: 'image/webp', w: 10, h: 20 } },
            { kind: 'image', file: { url: 'mxc://purr.example/enc' }, info: { mimetype: 'image/png' } },
            { kind: 'image', url: 'https://evil.example/x.png', info: { mimetype: 'image/png' } },
            { kind: 'video', url: 'mxc://purr.example/bad', info: { mimetype: 'text/html' } },
          ],
        }),
      ],
      OWNER
    );
    assert.deepEqual(result.attachments, [{ kind: 'image', url: 'mxc://purr.example/ok', mimetype: 'image/webp', w: 10, h: 20 }]);
  });
});

describe('readEmotes', () => {
  it('reads emote images in any attribute order and nothing else', () => {
    assert.deepEqual(readEmotes('<img title=":a:" src="mxc://s/a" data-mx-emoticon> <img src="mxc://s/b" alt="b"> <img data-mx-emoticon src="https://x/y" alt=":c:">'), [
      { shortcode: 'a', url: 'mxc://s/a' },
    ]);
    assert.deepEqual(readEmotes(undefined), []);
  });
});

describe('pageOfPosts', () => {
  const posts = [3, 1, 2, 5, 4].map((ts) => ({ eventId: `$${ts}`, ts }) as PublicPost);

  it('pages newest first by time', () => {
    const first = pageOfPosts(posts, undefined, 2);
    assert.deepEqual(
      first.posts.map((p) => p.ts),
      [5, 4]
    );
    assert.equal(first.next, 4);
    const second = pageOfPosts(posts, first.next, 2);
    assert.deepEqual(
      second.posts.map((p) => p.ts),
      [3, 2]
    );
    const last = pageOfPosts(posts, second.next, 2);
    assert.deepEqual(
      last.posts.map((p) => p.ts),
      [1]
    );
    assert.equal(last.next, undefined);
  });
});

describe('which media may be served', () => {
  const PAGE_STATE = (publicWeb: boolean, page: Record<string, unknown>): RawEvent[] => [
    ...ROOM_STATE,
    { type: 'xyz.nekous.public_web', state_key: '', sender: OWNER, content: { enabled: publicWeb } },
    { type: 'xyz.nekous.profile_page', state_key: '', sender: OWNER, event_id: '$page', content: { version: 1, ...page } },
  ];
  const noLists = (): AdminLists => ({ hidden: new Set(), publicOff: new Set(), blockedMedia: new Set() });
  const TRACK = 'mxc://purr.example/track1';
  const PAGE = {
    style: { background: { kind: 'image', url: 'mxc://purr.example/bg' } },
    blocks: [
      { type: 'image', url: 'mxc://purr.example/img' },
      { type: 'gallery', images: [{ url: 'mxc://purr.example/g1' }, { url: 'not mxc' }] },
      { type: 'links', items: [{ label: 'x', url: 'https://e.org', emote: 'mxc://purr.example/emote' }] },
      { type: 'art', albums: [{ title: 'A', pieces: [{ url: 'mxc://purr.example/art1' }] }] },
      { type: 'music', tracks: [{ url: TRACK, mimetype: 'audio/mpeg', title: 't' }, { url: 'mxc://purr.example/notaudio', mimetype: 'text/html', title: 'x' }] },
      // Fields no page draws: never served because of this page.
      { type: 'text', body: 'hi', smuggled: 'mxc://purr.example/dm-photo' },
      { type: 'unknown', url: 'mxc://purr.example/other' },
    ],
    extra: { url: 'mxc://purr.example/secret' },
  };

  it('collects every mxc URL in a value', () => {
    assert.deepEqual([...collectMxc({ a: 'mxc://s/1', b: [{ c: 'mxc://s/2' }, 'mxc://s/bad id'], d: 'text' })], ['mxc://s/1', 'mxc://s/2']);
  });

  it("takes a page's files only from fields the page format has", () => {
    assert.deepEqual([...pageMedia(PAGE)].sort(), [
      'mxc://purr.example/art1',
      'mxc://purr.example/bg',
      'mxc://purr.example/emote',
      'mxc://purr.example/g1',
      'mxc://purr.example/img',
      TRACK,
    ]);
  });

  it("serves a page's files only while the owner is opted in", () => {
    const snapshot = new Map<string, MediaSource[]>();
    addRoomMedia(snapshot, { owner: OWNER, posts: [], state: PAGE_STATE(false, PAGE) });
    assert.equal(snapshot.size, 0);
    addRoomMedia(snapshot, { owner: OWNER, posts: [], state: PAGE_STATE(true, PAGE) });
    const index = new MediaIndex();
    index.setSnapshot(snapshot);
    const sources = index.sources(TRACK);
    assert.equal(mayServeMedia(TRACK, sources, noLists(), new Set([OWNER])), true);
    // Switched off since the snapshot: the next snapshot drops it, and until then the live set does.
    assert.equal(mayServeMedia(TRACK, sources, noLists(), new Set()), false);
    assert.equal(mayServeMedia('mxc://purr.example/secret', index.sources('mxc://purr.example/secret'), noLists(), new Set([OWNER])), false);
  });

  it('never serves a file for a hidden owner, a page an admin switched off, or a blocked file', () => {
    const snapshot = new Map<string, MediaSource[]>();
    const posts: PublicPost[] = [
      { eventId: '$p', author: OWNER, ts: 1, body: '', attachments: [{ kind: 'image', url: 'mxc://purr.example/postpic', mimetype: 'image/png' }], likes: 0, comments: 0 },
    ];
    addRoomMedia(snapshot, { owner: OWNER, posts, state: PAGE_STATE(true, PAGE) });
    const index = new MediaIndex();
    index.setSnapshot(snapshot);
    const live = new Set([OWNER]);
    const serve = (url: string, lists: AdminLists) => mayServeMedia(url, index.sources(url), lists, live);

    assert.equal(serve('mxc://purr.example/postpic', noLists()), true);
    assert.equal(serve('mxc://purr.example/postpic', { ...noLists(), hidden: new Set([OWNER]) }), false);
    assert.equal(serve(TRACK, { ...noLists(), hidden: new Set([OWNER]) }), false);
    // Switched off by an admin: the page's files go, Global posts' stay (they're public regardless).
    assert.equal(serve(TRACK, { ...noLists(), publicOff: new Set([OWNER]) }), false);
    assert.equal(serve('mxc://purr.example/postpic', { ...noLists(), publicOff: new Set([OWNER]) }), true);
    assert.equal(serve('mxc://purr.example/postpic', { ...noLists(), blockedMedia: new Set(['mxc://purr.example/postpic']) }), false);
    assert.equal(serve('mxc://purr.example/never-named', noLists()), false);
  });

  it('serves a shared file while any owner of it still may', () => {
    const sources: MediaSource[] = [
      { owner: '@a:s', kind: 'post' },
      { owner: '@b:s', kind: 'post' },
    ];
    assert.equal(mayServeMedia('mxc://s/x', sources, { ...noLists(), hidden: new Set(['@a:s']) }, new Set()), true);
    assert.equal(mayServeMedia('mxc://s/x', sources, { ...noLists(), hidden: new Set(['@a:s', '@b:s']) }, new Set()), false);
  });

  it("keeps avatars and banners for a while, a banner counting as the page's", () => {
    const index = new MediaIndex(1000);
    index.allowProfile(['mxc://s/avatar', 'https://evil/x'], OWNER, 'profile', 0);
    index.allowProfile(['mxc://s/banner'], OWNER, 'page', 0);
    assert.deepEqual(index.sources('mxc://s/avatar', 500), [{ owner: OWNER, kind: 'profile' }]);
    assert.equal(mayServeMedia('mxc://s/banner', index.sources('mxc://s/banner', 500), noLists(), new Set()), false);
    assert.deepEqual(index.ownedBy(OWNER, 500).sort(), ['mxc://s/avatar', 'mxc://s/banner']);
    assert.deepEqual(index.sources('mxc://s/avatar', 1500), []);
  });

  it('passes on pictures, video and the allowed sound, never anything a browser would run', () => {
    for (const ok of ['image/png', 'image/gif; charset=binary', 'video/mp4', 'audio/mpeg', 'audio/ogg; codecs=opus', 'AUDIO/FLAC']) {
      assert.equal(isServableMediaType(ok), true, ok);
    }
    for (const bad of ['text/html', 'image/svg+xml', 'application/javascript', 'audio/x-unknown', 'audio/', null, '']) {
      assert.equal(isServableMediaType(bad), false, String(bad));
    }
    assert.equal(isSeekableMediaType('audio/mpeg'), true);
    assert.equal(isSeekableMediaType('video/webm'), true);
    assert.equal(isSeekableMediaType('image/png'), false);
    assert.equal(isSeekableMediaType('audio/x-unknown'), false);
  });
});

describe('the Top 8 for signed-out visitors', () => {
  const follow = (owner: string, target: string, following = true, sender = owner): RawEvent => ({
    type: 'xyz.nekous.follow',
    state_key: target,
    sender,
    content: { following },
  });

  it('reads who someone follows from their own follow events only', () => {
    const state = [
      follow(OWNER, '@a:s'),
      follow(OWNER, 'd:s'),
      follow(OWNER, '@b:s', false),
      follow(OWNER, '@c:s', true, '@intruder:s'),
      follow(OWNER, 'not a user'),
      { type: 'xyz.nekous.follow', sender: OWNER, content: { following: true } },
    ];
    assert.deepEqual([...readFollows(state, OWNER)], ['@a:s', '@d:s']);
  });

  it('keeps only the friends allowed, and leaves every other block as stored', () => {
    const content = {
      version: 1,
      blocks: [
        { id: 'f', type: 'friends', users: ['@public-and-mutual:s', '@not-public:s', '@not-mutual:s', 42] },
        { id: 't', type: 'text', body: 'hi' },
      ],
    };
    const shown = publicPageContent(content, (user) => user === '@public-and-mutual:s');
    assert.deepEqual(shown.blocks, [
      { id: 'f', type: 'friends', users: ['@public-and-mutual:s'] },
      { id: 't', type: 'text', body: 'hi' },
    ]);
    assert.ok(!JSON.stringify(shown).includes('@not-public:s'));
    assert.equal(content.blocks[0].users?.length, 4, 'the stored page is not changed');
  });
});

describe('mature art, signed out', () => {
  const content = {
    version: 1,
    blocks: [
      {
        type: 'art',
        albums: [{ title: 'A', pieces: [{ url: 'mxc://s/general', rating: 'general' }, { url: 'mxc://s/mature', rating: 'mature' }, { url: 'mxc://s/unrated' }] }],
      },
    ],
  };

  it('is left out of the page answer', () => {
    assert.ok(!JSON.stringify(publicPageContent(content, () => true)).includes('mxc://s/mature'));
    assert.ok(JSON.stringify(publicPageContent(content, () => true)).includes('mxc://s/unrated'));
  });

  it("is never one of a page's public files", () => {
    assert.deepEqual([...pageMedia(content)].sort(), ['mxc://s/general', 'mxc://s/unrated']);
    assert.ok(pageMedia(content, { includeMature: true }).has('mxc://s/mature'));
  });
});

describe('mature pieces in a gallery block, signed out', () => {
  const content = {
    version: 1,
    blocks: [
      {
        type: 'gallery',
        ratings: true,
        albums: [{ title: 'A', pieces: [{ url: 'mxc://s/general' }, { url: 'mxc://s/mature', rating: 'mature' }] }],
        images: [{ url: 'mxc://s/flat' }],
      },
    ],
  };

  it('are left out of the page answer, as in the older art block', () => {
    const shown = JSON.stringify(publicPageContent(content, () => true));
    assert.ok(!shown.includes('mxc://s/mature'));
    assert.ok(shown.includes('mxc://s/general'));
  });

  it("are never public files, while a gallery's albums and older flat images are", () => {
    assert.deepEqual([...pageMedia(content)].sort(), ['mxc://s/flat', 'mxc://s/general']);
    assert.ok(pageMedia(content, { includeMature: true }).has('mxc://s/mature'));
  });
});

describe('parseRange', () => {
  it('reads one range of a file', () => {
    assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
    assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
  });

  it('says when a range is past the end', () => {
    assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
    assert.equal(parseRange('bytes=50-10', 1000), 'unsatisfiable');
    assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable');
  });

  it('sends the whole file for anything else', () => {
    for (const header of [undefined, '', 'bytes=-', 'bytes=0-1,5-9', 'items=0-5', 'bytes=a-b', 'bytes=1e3-', `bytes=${'9'.repeat(30)}-`]) {
      assert.equal(parseRange(header, 1000), undefined, String(header));
    }
  });
});

describe('admin hiding', () => {
  it('reads one user ID per line, ignoring comments and junk', () => {
    assert.deepEqual([...parseHiddenList('@a:s\n# a note\n  @b:s  # spam\nnot a user\n\r\n')], ['@a:s', '@b:s']);
  });
});

describe('linkCardHtml', () => {
  it('escapes everything a person wrote', () => {
    const html = linkCardHtml({
      title: '"><script>alert(1)</script>',
      description: "it's <b>bold</b>",
      url: 'https://purr.example/@x"onmouseover="y',
      siteName: 'Purrlor',
      themeColor: 'red;}',
    });
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<b>'));
    assert.ok(!html.includes('"onmouseover'));
    assert.ok(!html.includes('theme-color'));
    assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
  });
});
