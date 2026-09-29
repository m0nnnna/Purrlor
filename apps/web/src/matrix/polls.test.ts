import { describe, expect, it } from 'vitest';
import type { MatrixEvent } from 'matrix-js-sdk';
import { isPollEndEvent, isPollResponseEvent, isPollStartEvent, parsePollEnd, parsePollResponse, parsePollStart } from './polls';

function fakeEvent(type: string, content: Record<string, unknown>): MatrixEvent {
  return { getType: () => type, getContent: () => content } as unknown as MatrixEvent;
}

describe('poll event type guards', () => {
  it('match both the unstable type this app sends and the stable m.poll.* type Element may send', () => {
    expect(isPollStartEvent(fakeEvent('org.matrix.msc3381.poll.start', {}))).toBe(true);
    expect(isPollStartEvent(fakeEvent('m.poll.start', {}))).toBe(true);
    expect(isPollStartEvent(fakeEvent('m.room.message', {}))).toBe(false);

    expect(isPollResponseEvent(fakeEvent('org.matrix.msc3381.poll.response', {}))).toBe(true);
    expect(isPollResponseEvent(fakeEvent('m.poll.response', {}))).toBe(true);

    expect(isPollEndEvent(fakeEvent('org.matrix.msc3381.poll.end', {}))).toBe(true);
    expect(isPollEndEvent(fakeEvent('m.poll.end', {}))).toBe(true);
  });
});

describe('parsePollStart', () => {
  it('reads a well-formed unstable-namespaced poll start', () => {
    const event = fakeEvent('org.matrix.msc3381.poll.start', {
      'org.matrix.msc3381.poll.start': {
        question: { 'org.matrix.msc1767.text': 'Best cat?' },
        kind: 'org.matrix.msc3381.poll.disclosed',
        max_selections: 1,
        answers: [
          { id: 'a', 'org.matrix.msc1767.text': 'Tabby' },
          { id: 'b', 'org.matrix.msc1767.text': 'Tuxedo' },
        ],
      },
      'org.matrix.msc1767.text': 'Best cat?\n1. Tabby\n2. Tuxedo',
    });
    expect(parsePollStart(event)).toEqual({
      question: 'Best cat?',
      kind: 'disclosed',
      maxSelections: 1,
      answers: [
        { id: 'a', text: 'Tabby' },
        { id: 'b', text: 'Tuxedo' },
      ],
    });
  });

  it('reads the stable m.poll.* names too, for interop with a client that sends those', () => {
    const event = fakeEvent('m.poll.start', {
      'm.poll.start': {
        question: { 'm.text': 'Pick one' },
        kind: 'm.poll.undisclosed',
        answers: [
          { id: 'x', 'm.text': 'One' },
          { id: 'y', 'm.text': 'Two' },
        ],
      },
    });
    const parsed = parsePollStart(event);
    expect(parsed?.question).toBe('Pick one');
    expect(parsed?.kind).toBe('undisclosed');
    expect(parsed?.maxSelections).toBe(1); // no max_selections sent — defaults to single-choice
  });

  it('is null for a non-poll event, and for malformed poll content', () => {
    expect(parsePollStart(fakeEvent('m.room.message', { body: 'hi' }))).toBeNull();
    // No question.
    expect(
      parsePollStart(fakeEvent('org.matrix.msc3381.poll.start', { 'org.matrix.msc3381.poll.start': { answers: [{ id: 'a' }] } }))
    ).toBeNull();
    // No answers.
    expect(
      parsePollStart(
        fakeEvent('org.matrix.msc3381.poll.start', {
          'org.matrix.msc3381.poll.start': { question: { 'org.matrix.msc1767.text': 'Q' }, answers: [] },
        })
      )
    ).toBeNull();
  });

  it('drops malformed individual answers (no id) rather than failing the whole poll', () => {
    const event = fakeEvent('org.matrix.msc3381.poll.start', {
      'org.matrix.msc3381.poll.start': {
        question: { 'org.matrix.msc1767.text': 'Q' },
        answers: [{ id: 'a', 'org.matrix.msc1767.text': 'A' }, { 'org.matrix.msc1767.text': 'no id' }, 'not even an object'],
      },
    });
    expect(parsePollStart(event)?.answers).toEqual([{ id: 'a', text: 'A' }]);
  });

  it('clamps max_selections to the number of answers available', () => {
    const event = fakeEvent('org.matrix.msc3381.poll.start', {
      'org.matrix.msc3381.poll.start': {
        question: { 'org.matrix.msc1767.text': 'Q' },
        max_selections: 10,
        answers: [
          { id: 'a', 'org.matrix.msc1767.text': 'A' },
          { id: 'b', 'org.matrix.msc1767.text': 'B' },
        ],
      },
    });
    expect(parsePollStart(event)?.maxSelections).toBe(2);
  });
});

describe('parsePollResponse', () => {
  it('reads the target poll and selected answers', () => {
    const event = fakeEvent('org.matrix.msc3381.poll.response', {
      'm.relates_to': { rel_type: 'm.reference', event_id: '$poll' },
      'org.matrix.msc3381.poll.response': { answers: ['a', 'b'] },
    });
    expect(parsePollResponse(event)).toEqual({ pollEventId: '$poll', answerIds: ['a', 'b'] });
  });

  it('is null without a valid m.reference relation', () => {
    expect(
      parsePollResponse(
        fakeEvent('org.matrix.msc3381.poll.response', { 'org.matrix.msc3381.poll.response': { answers: ['a'] } })
      )
    ).toBeNull();
    expect(
      parsePollResponse(
        fakeEvent('org.matrix.msc3381.poll.response', {
          'm.relates_to': { rel_type: 'm.replace', event_id: '$poll' },
          'org.matrix.msc3381.poll.response': { answers: ['a'] },
        })
      )
    ).toBeNull();
  });

  it('treats a missing/non-array answers list as no selection, without throwing', () => {
    const event = fakeEvent('org.matrix.msc3381.poll.response', {
      'm.relates_to': { rel_type: 'm.reference', event_id: '$poll' },
    });
    expect(parsePollResponse(event)).toEqual({ pollEventId: '$poll', answerIds: [] });
  });
});

describe('parsePollEnd', () => {
  it('reads the target poll id', () => {
    const event = fakeEvent('org.matrix.msc3381.poll.end', {
      'm.relates_to': { rel_type: 'm.reference', event_id: '$poll' },
      'org.matrix.msc3381.poll.end': {},
    });
    expect(parsePollEnd(event)).toEqual({ pollEventId: '$poll' });
  });

  it('is null without a valid relation', () => {
    expect(parsePollEnd(fakeEvent('org.matrix.msc3381.poll.end', {}))).toBeNull();
  });
});
