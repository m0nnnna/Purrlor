import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectMxc,
  isServableMediaType,
  linkCardHtml,
  localUserId,
  MediaAllowlist,
  pageOfPosts,
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

describe('MediaAllowlist', () => {
  it('serves only media a public answer handed out, and only for a while', () => {
    const allow = new MediaAllowlist(1000);
    allow.allow(['mxc://s/a', 'https://evil/x'], 0);
    assert.equal(allow.has('mxc://s/a', 500), true);
    assert.equal(allow.has('mxc://s/b', 500), false);
    assert.equal(allow.has('mxc://s/a', 1500), false);
  });

  it('collects every mxc URL in a value', () => {
    assert.deepEqual([...collectMxc({ a: 'mxc://s/1', b: [{ c: 'mxc://s/2' }, 'mxc://s/bad id'], d: 'text' })], ['mxc://s/1', 'mxc://s/2']);
  });

  it('passes on pictures, video and sound, never anything a browser would run', () => {
    for (const ok of ['image/png', 'image/gif; charset=binary', 'video/mp4', 'audio/mpeg']) assert.equal(isServableMediaType(ok), true, ok);
    for (const bad of ['text/html', 'image/svg+xml', 'application/javascript', null, '']) assert.equal(isServableMediaType(bad), false, String(bad));
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
