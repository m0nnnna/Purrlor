import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { MatrixClientContext } from '../../matrix/MatrixClientContext';
import { createDemoClient } from '../../demo/demoClient';
import { DEMO_ROOM_IDS } from '../../demo/demoWorld';
import { CALENDAR_EVENT } from '../../matrix/calendar';
import { announceEvent } from '../../matrix/calendarNotice';
import { CalendarView } from './CalendarView';

afterEach(cleanup);

async function renderCalendar() {
  const mx = createDemoClient();
  const space = mx.getRoom(DEMO_ROOM_IDS.cafe)!;
  // Today's (earlier today, so it may already be over), and one tomorrow that's certainly still coming up.
  const today = new Date();
  today.setHours(0, 5, 0, 0);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(12, 0, 0, 0);
  await mx.sendStateEvent(space.roomId, CALENDAR_EVENT as never, { title: 'Movie night', description: '', start: today.getTime() } as never, 'evt1');
  await mx.sendStateEvent(space.roomId, CALENDAR_EVENT as never, { title: 'Tomorrow thing', description: '', start: tomorrow.getTime() } as never, 'evt2');
  render(
    <JotaiProvider>
      <MatrixClientContext.Provider value={mx}>
        <CalendarView space={space} />
      </MatrixClientContext.Provider>
    </JotaiProvider>
  );
  return mx;
}

describe('CalendarView month view', () => {
  it('shows the month as a grid with the event on its day, and what’s on a picked day beneath', async () => {
    await renderCalendar();
    fireEvent.click(await screen.findByRole('tab', { name: 'Month' }));

    const cells = screen.getAllByRole('gridcell');
    expect(cells.length % 7).toBe(0);
    const today = cells.find((cell) => cell.className.includes('nu-calendar__cell--today'))!;
    expect(today.textContent).toContain('Movie night');

    // Picking an empty day shows there's nothing on it; picking today shows the event's card.
    // Empty means no event in the cell (just its number): on the 1st of a month the next day is
    // tomorrow, which has one.
    const emptyDay = cells.find(
      (cell) => !cell.className.includes('--today') && !cell.className.includes('--outside') && /^\d+$/.test(cell.textContent?.trim() ?? '')
    )!;
    fireEvent.click(emptyDay);
    expect(screen.getByText(/^Nothing on /)).toBeInTheDocument();
    fireEvent.click(today);
    expect(screen.getByRole('heading', { name: 'Movie night' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to calendar' })).toBeInTheDocument();
  });

  it('downloads an .ics of what’s coming up', async () => {
    await renderCalendar();
    let saved: Blob | undefined;
    URL.createObjectURL = vi.fn((blob: Blob) => ((saved = blob), 'blob:x'));
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined); // jsdom can't navigate
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    await waitFor(() => expect(saved).toBeDefined());
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(saved!);
    });
    expect(text).toContain('BEGIN:VCALENDAR');
    expect(text).toContain('SUMMARY:Tomorrow thing');
  });
});

describe('announceEvent', () => {
  it('posts a quiet notice in the channel', async () => {
    const sendMessage = vi.fn(async (..._args: unknown[]) => ({}));
    await announceEvent({ sendMessage } as never, '!chan', { title: 'Movie night', start: Date.UTC(2026, 9, 2, 19) });
    expect(sendMessage.mock.calls[0][0]).toBe('!chan');
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ msgtype: 'm.notice' });
    expect((sendMessage.mock.calls[0][1] as { body: string }).body).toContain('Movie night');
  });
});
