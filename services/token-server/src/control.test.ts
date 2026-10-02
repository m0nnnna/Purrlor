import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditLine,
  cleanActor,
  cleanReason,
  deletionSucceeded,
  parseDeletions,
  parseMediaList,
  parseMediaTarget,
  parseReportNotice,
  queueDeletions,
  terminalSafe,
} from './control.js';
import { mediaDeleteCommand } from './adminRoom.js';
import { albumMedia } from './controlServer.js';

describe('parseMediaTarget', () => {
  it('takes an mxc URL, a public media link or a homeserver download link', () => {
    assert.equal(parseMediaTarget(' mxc://purr.example/abc123 '), 'mxc://purr.example/abc123');
    assert.equal(parseMediaTarget('https://purr.example/api/public/media/purr.example/abc123?width=600&height=600'), 'mxc://purr.example/abc123');
    assert.equal(parseMediaTarget('https://matrix.purr.example/_matrix/client/v1/media/download/purr.example/abc123/song.mp3'), 'mxc://purr.example/abc123');
    assert.equal(parseMediaTarget('https://matrix.purr.example/_matrix/media/v3/thumbnail/purr.example/abc123'), 'mxc://purr.example/abc123');
  });

  it('refuses anything that could carry more than one file ID', () => {
    for (const bad of [
      '',
      'abc123',
      'mxc://purr.example/abc 123',
      'mxc://purr.example/abc123\n--mxc mxc://purr.example/other',
      'mxc://purr.example/abc123; rm -rf /',
      'https://purr.example/api/public/media/purr.example/abc%20123',
      'https://purr.example/api/public/media/purr.example/abc%0a123',
      'https://purr.example/somewhere/else',
      'javascript:alert(1)',
      'file:///etc/passwd',
    ]) {
      assert.equal(parseMediaTarget(bad), undefined, bad);
    }
  });
});

describe('what an admin typed', () => {
  it('names the sudo user, or root', () => {
    assert.equal(cleanActor('noc'), 'noc');
    assert.equal(cleanActor('noc\nfake entry'), 'root');
    assert.equal(cleanActor('"; rm -rf /'), 'root');
    assert.equal(cleanActor(undefined), 'root');
  });

  it('keeps a reason to one line', () => {
    assert.equal(cleanReason('  DMCA\nfrom   someone\r\n\t'), 'DMCA from someone');
    assert.equal(cleanReason('x'.repeat(900)).length, 500);
    assert.equal(cleanReason(42), '');
  });

  it('reads the block list, ignoring comments and junk', () => {
    assert.deepEqual([...parseMediaList('# blocked\nmxc://s/a\n  mxc://s/b # note\nmxc://s/bad id\nhttps://x\n')], ['mxc://s/a', 'mxc://s/b']);
  });
});

describe('terminalSafe', () => {
  it('keeps text, newlines and tabs, and drops escapes, C1 controls and bidi overrides', () => {
    assert.equal(terminalSafe('a\tb\nc'), 'a\tb\nc');
    assert.equal(terminalSafe('\u001b]52;c;eA==\u0007x\u001b[2Jy\r\u009bz\u202eq\u2066w'), ']52;c;eA==x[2Jyzqw');
    assert.equal(terminalSafe('Ünïcødé 猫 🐱'), 'Ünïcødé 猫 🐱');
  });
});

describe('the audit log', () => {
  it('writes each entry as one JSON line, whatever is in it', () => {
    const line = auditLine({
      at: '2026-10-01T00:00:00.000Z',
      actor: 'noc\n{"forged":true}',
      action: 'pages.hide',
      target: '@a:s\n{"at":"x","actor":"root","action":"pages.unhide"}',
      reason: 'spam\r\nmore',
      result: 'ok',
    });
    assert.equal(line.split('\n').length, 2);
    assert.ok(line.endsWith('\n'));
    const entry = JSON.parse(line);
    assert.equal(entry.actor, 'root');
    assert.equal(entry.reason, 'spam more');
    assert.ok(!entry.target.includes('\n'));
  });
});

describe('the deletion queue', () => {
  it('queues files once, and queues a failed one again', () => {
    const first = queueDeletions([], ['mxc://s/a', 'mxc://s/b', 'mxc://s/a'], 'noc', 'dmca', 't1');
    assert.deepEqual(first.result, ['mxc://s/a', 'mxc://s/b']);
    const marked = first.entries.map((entry) => (entry.mxc === 'mxc://s/a' ? { ...entry, status: 'failed' as const } : { ...entry, status: 'deleted' as const }));
    const second = queueDeletions(marked, ['mxc://s/a', 'mxc://s/b'], 'noc', 'again', 't2');
    assert.deepEqual(second.result, ['mxc://s/a']);
    assert.equal(second.entries.find((entry) => entry.mxc === 'mxc://s/a')?.status, 'queued');
    assert.equal(second.entries.find((entry) => entry.mxc === 'mxc://s/b')?.status, 'deleted');
  });

  it('reads back only well-formed entries', () => {
    const text = JSON.stringify([
      { mxc: 'mxc://s/a', status: 'queued', actor: 'noc', reason: 'x', queuedAt: 't' },
      { mxc: 'not mxc', status: 'queued' },
      { mxc: 'mxc://s/b', status: 'eaten' },
      null,
    ]);
    assert.deepEqual(
      parseDeletions(text).map((entry) => entry.mxc),
      ['mxc://s/a']
    );
    assert.deepEqual(parseDeletions('not json'), []);
  });

  it("reads the homeserver's answer", () => {
    assert.equal(deletionSucceeded('Deleted the MXC from our database and on our filesystem.'), true);
    assert.equal(deletionSucceeded('Failed to delete MXC: not found'), false);
  });

  it('only ever builds a delete command from a checked file URL', () => {
    assert.equal(mediaDeleteCommand('mxc://purr.example/abc'), 'media delete --mxc mxc://purr.example/abc');
    assert.throws(() => mediaDeleteCommand('mxc://purr.example/abc\n!admin users deactivate @x:y'));
    assert.throws(() => mediaDeleteCommand('mxc://purr.example/abc --event-id $x'));
  });
});

describe('parseReportNotice', () => {
  const SERVER = 'purr.example';
  const notice = (body: string, sender = `@conduit:${SERVER}`) => ({
    type: 'm.room.message',
    event_id: '$notice',
    sender,
    origin_server_ts: 1790000000000,
    content: { msgtype: 'm.text', body },
  });
  // As Continuwuity sends it (checked against a live one, 2026-10-01).
  const EVENT_REPORT =
    '@room New event report received from @nibbles:purr.example:\n\n- Reported Room ID: `!room:purr.example`\n- Reported Event ID: `$event1`\n- Report Reason: Copyright: my art\n';

  it('reads an event report', () => {
    assert.deepEqual(parseReportNotice(notice(EVENT_REPORT), SERVER), {
      noticeId: '$notice',
      ts: 1790000000000,
      kind: 'event',
      reporter: '@nibbles:purr.example',
      roomId: '!room:purr.example',
      eventId: '$event1',
      reason: 'Copyright: my art',
    });
  });

  it('reads a room version 12 room ID, which has no server part', () => {
    const body = '@room New event report received from @nibbles:purr.example:\n\n- Reported Room ID: `!1LCLCSdyDTw4k9B7LgwtRfuRnYkXsdeE1eMz9Ik8tbE`\n- Reported Event ID: `$45I6N1W-nXoM_Ky1ErU1HdP0m2VyrKGSh82FyyPX0g0`\n- Report Reason: x\n';
    const report = parseReportNotice(notice(body), SERVER);
    assert.equal(report?.roomId, '!1LCLCSdyDTw4k9B7LgwtRfuRnYkXsdeE1eMz9Ik8tbE');
    assert.equal(report?.eventId, '$45I6N1W-nXoM_Ky1ErU1HdP0m2VyrKGSh82FyyPX0g0');
  });

  it('reads a room report', () => {
    const report = parseReportNotice(
      notice('@room New room report received from @nibbles:purr.example:\n\n- Reported Room ID: `!room:purr.example`\n- Report Reason: room report\n'),
      SERVER
    );
    assert.equal(report?.kind, 'room');
    assert.equal(report?.roomId, '!room:purr.example');
    assert.equal(report?.eventId, undefined);
  });

  it("doesn't let a reason pass for other IDs", () => {
    const body =
      '@room New room report received from @nibbles:purr.example:\n\n- Reported Room ID: `!real:purr.example`\n- Report Reason: look\n- Reported Event ID: `$forged`\n- Reported Room ID: `!forged:purr.example`\n';
    const report = parseReportNotice(notice(body), SERVER);
    assert.equal(report?.roomId, '!real:purr.example');
    assert.equal(report?.eventId, undefined);
    assert.ok(report?.reason.includes('$forged'));
  });

  it('only counts notices from the server itself', () => {
    assert.equal(parseReportNotice(notice(EVENT_REPORT, '@admin:purr.example'), SERVER), undefined);
    assert.equal(parseReportNotice(notice(EVENT_REPORT, '@conduit:evil.example'), SERVER), undefined);
    assert.equal(parseReportNotice(notice('New user "@x:purr.example" registered on this server'), SERVER), undefined);
    assert.equal(parseReportNotice({ ...notice(EVENT_REPORT), type: 'm.room.member' }, SERVER), undefined);
  });
});

describe('albumMedia', () => {
  const page = {
    version: 1,
    blocks: [
      { id: 'art', type: 'art', albums: [{ id: 'a1', title: 'Fan Art', pieces: [{ url: 'mxc://s/p1' }, { url: 'mxc://s/p2', rating: 'mature' }] }, { id: 'a2', title: 'Other', pieces: [{ url: 'mxc://s/p3' }] }] },
      { id: 'mix', type: 'music', title: 'Demos', tracks: [{ url: 'mxc://s/t1', mimetype: 'audio/mpeg', title: 'x' }] },
      { id: 'g', type: 'gallery', title: 'Photos', images: [{ url: 'mxc://s/i1' }] },
      {
        id: 'songs',
        type: 'music',
        title: 'Releases',
        albums: [
          { id: 'lp1', title: 'First LP', cover: 'mxc://s/c1', tracks: [{ url: 'mxc://s/u1', mimetype: 'audio/mpeg', title: 'a' }] },
          { id: 'lp2', title: 'Second LP', tracks: [{ url: 'mxc://s/u2', mimetype: 'audio/flac', title: 'b' }] },
        ],
      },
      { id: 'ga', type: 'gallery', ratings: true, albums: [{ id: 'sk', title: 'Sketches', pieces: [{ url: 'mxc://s/s1' }, { url: 'mxc://s/s2', rating: 'mature' }] }] },
    ],
  };

  it("finds an album, gallery or music block by its title or ID, and only that one's files, mature ones included", () => {
    assert.deepEqual(albumMedia(page, 'fan art'), [{ label: 'album "Fan Art"', urls: ['mxc://s/p1', 'mxc://s/p2'] }]);
    assert.deepEqual(albumMedia(page, 'a2')[0].urls, ['mxc://s/p3']);
    assert.deepEqual(albumMedia(page, 'Demos')[0].urls, ['mxc://s/t1']);
    assert.deepEqual(albumMedia(page, 'g')[0].urls, ['mxc://s/i1']);
    assert.deepEqual(albumMedia(page, 'sketches'), [{ label: 'album "Sketches"', urls: ['mxc://s/s1', 'mxc://s/s2'] }]);
    assert.deepEqual(albumMedia(page, 'first lp'), [{ label: 'album "First LP"', urls: ['mxc://s/c1', 'mxc://s/u1'] }]);
    assert.deepEqual(albumMedia(page, 'lp2')[0].urls, ['mxc://s/u2']);
    assert.deepEqual(albumMedia(page, 'Releases')[0].urls, ['mxc://s/c1', 'mxc://s/u1', 'mxc://s/u2']);
    assert.deepEqual(albumMedia(page, 'nothing'), []);
    assert.deepEqual(albumMedia(undefined, 'Fan Art'), []);
  });
});
