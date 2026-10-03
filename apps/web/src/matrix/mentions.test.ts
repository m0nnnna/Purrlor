import { afterEach, describe, expect, it } from 'vitest';
import { buildMessageFormatting, findMentions, mentionCandidatesFor, parseFormattedBodyMentions } from './messageFormatting';
import { setHomeServer } from './homeServer';

afterEach(() => setHomeServer(undefined));

const people = [
  { userId: '@inso:purr.example', name: 'iNSo' },
  { userId: '@inso:cats.example', name: 'iNSo (@inso:cats.example)' },
  { userId: '@zoe:purr.example', name: 'Zoé' },
  { userId: '@mino:purr.example', name: 'mino' },
];

function mentioned(text: string): string[] {
  setHomeServer('purr.example');
  return buildMessageFormatting(text, [], mentionCandidatesFor(people)).mentionedUserIds;
}

describe('mentions typed by hand', () => {
  it('counts a name, a handle or a full user ID, in any case', () => {
    expect(mentioned('hey @iNSo')).toEqual(['@inso:purr.example']);
    expect(mentioned('hey @inso')).toEqual(['@inso:purr.example']);
    expect(mentioned('hey @MINO!')).toEqual(['@mino:purr.example']);
    expect(mentioned('hey @inso:cats.example')).toEqual(['@inso:cats.example']);
  });

  it("matches names that end in a letter \\b doesn't know, or a bracket", () => {
    expect(mentioned('merci @Zoé, à demain')).toEqual(['@zoe:purr.example']);
    expect(mentioned('@iNSo (@inso:cats.example) look')).toEqual(['@inso:cats.example']);
  });

  it("doesn't take a local handle out of another server's user ID", () => {
    expect(mentioned('@inso:elsewhere.example hi')).toEqual([]);
  });

  it("doesn't count an @ inside a word, or a longer name", () => {
    expect(mentioned('mail me@inso.example')).toEqual([]);
    expect(mentioned('@minotaur')).toEqual([]);
  });

  it('links each mention so other clients show a pill', () => {
    setHomeServer('purr.example');
    const { formattedBody } = buildMessageFormatting('hi @inso', [], mentionCandidatesFor(people));
    expect(formattedBody).toBe('hi <a href="https://matrix.to/#/@inso:purr.example">@inso</a>');
  });
});

describe('findMentions', () => {
  it('prefers the longest match, and the first target for a text', () => {
    const found = findMentions('@ab', [
      { text: '@a', userId: '@a:x' },
      { text: '@ab', userId: '@ab:x' },
      { text: '@AB', userId: '@other:x' },
    ]);
    expect(found).toEqual([{ index: 0, length: 3, userId: '@ab:x' }]);
  });
});

describe('parseFormattedBodyMentions', () => {
  it("reads the mention links a sender's client wrote", () => {
    expect(
      parseFormattedBodyMentions('hi <a href="https://matrix.to/#/%40luna%3Acats.example">Luna &amp; co</a> and <a href="https://example.org">x</a>')
    ).toEqual([{ text: '@Luna & co', userId: '@luna:cats.example' }]);
  });
});
