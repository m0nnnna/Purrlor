import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { MatrixClientContext } from '../matrix/MatrixClientContext';
import { createDemoClient } from '../demo/demoClient';
import { DEMO_ROOM_IDS } from '../demo/demoWorld';
import { readReminders } from '../matrix/reminders';
import { RemindersSettings } from './RemindersSettings';

afterEach(cleanup);

describe('RemindersSettings', () => {
  it('lists pending message reminders, soonest first, and cancelling one removes it', async () => {
    const mx = createDemoClient();
    const at = Date.now();
    await mx.setAccountData('xyz.nekous.reminders' as never, {
      items: [
        { id: 'later', roomId: DEMO_ROOM_IDS.general, eventId: '$2', remindAt: at + 7_200_000, preview: 'second one' },
        { id: 'soon', roomId: DEMO_ROOM_IDS.general, eventId: '$1', remindAt: at + 600_000, preview: 'first one' },
      ],
    } as never);

    render(
      <JotaiProvider>
        <MatrixClientContext.Provider value={mx}>
          <RemindersSettings onClose={() => undefined} />
        </MatrixClientContext.Provider>
      </JotaiProvider>
    );

    const items = screen.getAllByText(/one · #general/);
    expect(items.map((el) => el.textContent)).toEqual(['first one · #general', 'second one · #general']);

    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);
    await waitFor(() => expect(screen.queryByText(/first one/)).not.toBeInTheDocument());
    expect(readReminders(mx).map((r) => r.id)).toEqual(['later']);
  });

  it('says so when nothing is set', () => {
    render(
      <JotaiProvider>
        <MatrixClientContext.Provider value={createDemoClient()}>
          <RemindersSettings onClose={() => undefined} />
        </MatrixClientContext.Provider>
      </JotaiProvider>
    );
    expect(screen.getByText(/Nothing set/)).toBeInTheDocument();
  });
});
