import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MatrixClientContext } from '../../matrix/MatrixClientContext';
import { createDemoClient } from '../../demo/demoClient';
import { DEMO_ROOM_IDS } from '../../demo/demoWorld';
import { ChannelSettingsModal, canEditChannelSettings } from './ChannelSettingsModal';

afterEach(cleanup);

describe('ChannelSettingsModal', () => {
  it('is offered to an admin, and saving sends only what changed', async () => {
    const mx = createDemoClient();
    const channel = mx.getRoom(DEMO_ROOM_IDS.general)!;
    expect(canEditChannelSettings(channel, mx.getUserId()!)).toBe(true);

    const sent: [string, unknown][] = [];
    (mx as unknown as { sendStateEvent: (roomId: string, type: string, content: unknown) => Promise<unknown> }).sendStateEvent = async (
      _roomId,
      type,
      content
    ) => {
      sent.push([type, content]);
      return {};
    };
    let closed = false;
    render(
      <MatrixClientContext.Provider value={mx}>
        <ChannelSettingsModal channel={channel} onClose={() => (closed = true)} />
      </MatrixClientContext.Provider>
    );

    fireEvent.change(screen.getByDisplayValue('general'), { target: { value: 'lobby' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(closed).toBe(true));
    // The name only: the topic and avatar weren't touched.
    expect(sent).toEqual([['m.room.name', { name: 'lobby' }]]);
  });
});
