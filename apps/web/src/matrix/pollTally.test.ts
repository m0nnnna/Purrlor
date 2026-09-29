import { describe, expect, it } from 'vitest';
import { tallyPoll, type PollDefinition } from './pollTally';

const singleChoice: PollDefinition = {
  question: 'Best cat?',
  answers: [
    { id: 'a', text: 'Tabby' },
    { id: 'b', text: 'Tuxedo' },
    { id: 'c', text: 'Calico' },
  ],
  kind: 'disclosed',
  maxSelections: 1,
};

const multiChoice: PollDefinition = { ...singleChoice, maxSelections: 2 };

describe('tallyPoll', () => {
  it('counts one vote per answer for distinct single-choice voters', () => {
    const result = tallyPoll({
      definition: singleChoice,
      responses: [
        { senderId: '@a:x', ts: 1, answerIds: ['a'] },
        { senderId: '@b:x', ts: 2, answerIds: ['b'] },
        { senderId: '@c:x', ts: 3, answerIds: ['a'] },
      ],
    });
    expect(result.counts).toEqual({ a: 2, b: 1, c: 0 });
    expect(result.totalVotes).toBe(3);
    expect(result.ended).toBe(false);
  });

  it('latest-vote-wins: a later response from the same sender replaces their earlier one entirely', () => {
    const result = tallyPoll({
      definition: singleChoice,
      responses: [
        { senderId: '@a:x', ts: 1, answerIds: ['a'] },
        { senderId: '@a:x', ts: 5, answerIds: ['b'] },
        { senderId: '@a:x', ts: 3, answerIds: ['c'] }, // older than the ts:5 vote despite array position
      ],
    });
    expect(result.counts).toEqual({ a: 0, b: 1, c: 0 });
    expect(result.totalVotes).toBe(1);
  });

  it('breaks a timestamp tie using the caller-supplied (stream) order, not array position of insertion', () => {
    const result = tallyPoll({
      definition: singleChoice,
      responses: [
        { senderId: '@a:x', ts: 5, answerIds: ['a'] },
        { senderId: '@a:x', ts: 5, answerIds: ['b'] }, // same ts, later in the array = later in the stream
      ],
    });
    expect(result.counts.b).toBe(1);
    expect(result.counts.a).toBe(0);
  });

  it('ignores votes sent after the poll closed', () => {
    const result = tallyPoll({
      definition: singleChoice,
      responses: [
        { senderId: '@a:x', ts: 1, answerIds: ['a'] },
        { senderId: '@b:x', ts: 100, answerIds: ['b'] }, // arrives after the close
      ],
      endTs: 10,
    });
    expect(result.ended).toBe(true);
    expect(result.counts).toEqual({ a: 1, b: 0, c: 0 });
    expect(result.totalVotes).toBe(1);
  });

  it("still counts a sender's latest vote sent exactly at the close timestamp", () => {
    const result = tallyPoll({
      definition: singleChoice,
      responses: [{ senderId: '@a:x', ts: 10, answerIds: ['a'] }],
      endTs: 10,
    });
    expect(result.counts.a).toBe(1);
  });

  it('a revote sent after close does not un-cast an earlier, still-eligible vote from someone else', () => {
    const result = tallyPoll({
      definition: singleChoice,
      responses: [
        { senderId: '@a:x', ts: 1, answerIds: ['a'] },
        { senderId: '@a:x', ts: 50, answerIds: ['b'] }, // after close — ignored
      ],
      endTs: 10,
    });
    expect(result.counts).toEqual({ a: 1, b: 0, c: 0 });
    expect(result.totalVotes).toBe(1);
  });

  it('max_selections: extra selections beyond the limit are dropped, keeping the first N sent', () => {
    const result = tallyPoll({
      definition: multiChoice, // maxSelections: 2
      responses: [{ senderId: '@a:x', ts: 1, answerIds: ['a', 'b', 'c'] }],
    });
    expect(result.counts).toEqual({ a: 1, b: 1, c: 0 });
    expect(result.totalVotes).toBe(1);
  });

  it('invalid answer ids are ignored, not the whole response', () => {
    const result = tallyPoll({
      definition: singleChoice,
      responses: [{ senderId: '@a:x', ts: 1, answerIds: ['not-a-real-answer', 'a'] }],
    });
    expect(result.counts.a).toBe(1);
    expect(result.totalVotes).toBe(1);
  });

  it('a response left with zero valid ids after sanitizing counts nobody as a voter', () => {
    const result = tallyPoll({
      definition: singleChoice,
      responses: [{ senderId: '@a:x', ts: 1, answerIds: ['bogus'] }],
    });
    expect(result.totalVotes).toBe(0);
    expect(result.counts).toEqual({ a: 0, b: 0, c: 0 });
  });

  it('deduplicates repeated ids within one response', () => {
    const result = tallyPoll({
      definition: multiChoice,
      responses: [{ senderId: '@a:x', ts: 1, answerIds: ['a', 'a', 'a'] }],
    });
    expect(result.counts.a).toBe(1);
  });

  it("reports the requesting user's own latest valid selection via myAnswerIds", () => {
    const result = tallyPoll({
      definition: singleChoice,
      responses: [
        { senderId: '@a:x', ts: 1, answerIds: ['a'] },
        { senderId: '@a:x', ts: 5, answerIds: ['b'] },
        { senderId: '@b:x', ts: 1, answerIds: ['c'] },
      ],
      myUserId: '@a:x',
    });
    expect(result.myAnswerIds).toEqual(['b']);
  });

  it('myAnswerIds is empty when the user has not voted, or their only vote came after close', () => {
    expect(tallyPoll({ definition: singleChoice, responses: [], myUserId: '@a:x' }).myAnswerIds).toEqual([]);
    expect(
      tallyPoll({
        definition: singleChoice,
        responses: [{ senderId: '@a:x', ts: 50, answerIds: ['a'] }],
        endTs: 10,
        myUserId: '@a:x',
      }).myAnswerIds
    ).toEqual([]);
  });
});
