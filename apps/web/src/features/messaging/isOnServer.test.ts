import { describe, expect, it } from 'vitest';
import { MatrixEvent } from 'matrix-js-sdk';
import { isOnServer } from './MessageTimeline';

const message = (eventId: string) =>
  new MatrixEvent({ type: 'm.room.message', event_id: eventId, room_id: '!room:example.org', sender: '@me:example.org', content: { body: 'hi' } });

describe('isOnServer', () => {
  it('is an event the server sent us', () => {
    expect(isOnServer(message('$abc'))).toBe(true);
  });

  it('is not a message just sent, still under its local ID', () => {
    expect(isOnServer(message('~!room:example.org:m1793126125607.3'))).toBe(false);
  });

  it('is not an event with no ID yet', () => {
    expect(isOnServer(new MatrixEvent({ type: 'm.room.message', content: {} }))).toBe(false);
  });
});
