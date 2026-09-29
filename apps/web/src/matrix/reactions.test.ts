import { describe, expect, it, vi } from 'vitest';
import { EventType, RelationType, type MatrixClient } from 'matrix-js-sdk';
import { REACTION_SHORTCODE_FIELD, sendReaction } from './reactions';

function fakeClient() {
  const sendEvent = vi.fn().mockResolvedValue({});
  return { mx: { sendEvent } as unknown as MatrixClient, sendEvent };
}

describe('sendReaction', () => {
  it('sends a plain m.reaction annotation for a Unicode key, with no shortcode field', async () => {
    const { mx, sendEvent } = fakeClient();
    await sendReaction(mx, '!room:example.org', '$event', '👍');
    expect(sendEvent).toHaveBeenCalledWith('!room:example.org', EventType.Reaction, {
      'm.relates_to': { rel_type: RelationType.Annotation, event_id: '$event', key: '👍' },
    });
  });

  it("carries a custom emote's shortcode on com.beeper.reaction.shortcode when the key is its mxc URL", async () => {
    const { mx, sendEvent } = fakeClient();
    await sendReaction(mx, '!room:example.org', '$event', 'mxc://example.org/blob', 'blob');
    expect(sendEvent).toHaveBeenCalledWith('!room:example.org', EventType.Reaction, {
      'm.relates_to': { rel_type: RelationType.Annotation, event_id: '$event', key: 'mxc://example.org/blob' },
      [REACTION_SHORTCODE_FIELD]: 'blob',
    });
  });
});
