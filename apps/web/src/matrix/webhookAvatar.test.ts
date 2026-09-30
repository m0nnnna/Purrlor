import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { listWebhooks, mxcOrUndefined, setWebhookAvatar } from './webhooks';

function channel(content: Record<string, unknown> | undefined): Room {
  const event = content
    ? { getContent: () => content, getStateKey: () => 'w1', getSender: () => '@a:x', getTs: () => 1 }
    : null;
  return {
    roomId: '!c',
    currentState: { getStateEvents: (_type: string, key?: string) => (key === undefined ? (event ? [event] : []) : event) },
  } as unknown as Room;
}

describe('webhook avatars', () => {
  it('lists an mxc avatar and ignores anything else', () => {
    expect(listWebhooks(channel({ name: 'CI', token_sha256: 'h', avatar_url: 'mxc://s/a' }))[0].avatarUrl).toBe('mxc://s/a');
    expect(listWebhooks(channel({ name: 'CI', token_sha256: 'h', avatar_url: 'https://evil/a.png' }))[0].avatarUrl).toBeUndefined();
    expect(mxcOrUndefined(3)).toBeUndefined();
  });

  it('uploading one rewrites the state with the token’s hash untouched, and removing drops only the avatar', async () => {
    const sendStateEvent = vi.fn(async (..._args: unknown[]) => ({}));
    const mx = { uploadContent: async () => ({ content_uri: 'mxc://s/new' }), sendStateEvent } as unknown as MatrixClient;
    const room = channel({ name: 'CI', token_sha256: 'hash', avatar_url: 'mxc://s/old' });

    await setWebhookAvatar(mx, room, 'w1', new File(['x'], 'a.png'));
    expect(sendStateEvent.mock.calls[0][2]).toEqual({ name: 'CI', token_sha256: 'hash', avatar_url: 'mxc://s/new' });

    await setWebhookAvatar(mx, room, 'w1', undefined);
    expect(sendStateEvent.mock.calls[1][2]).toEqual({ name: 'CI', token_sha256: 'hash' });
  });

  it('refuses a webhook that’s gone', async () => {
    await expect(setWebhookAvatar({} as MatrixClient, channel(undefined), 'w1', undefined)).rejects.toThrow('no longer exists');
  });
});
