import { expect, test, type Page } from '@playwright/test';
import { logIn, message, openChannel, role } from './app';
import { api, createSpaceWithChannel, createUser, eventually, sendText, type TestUser } from './matrix';

const enc = encodeURIComponent;

async function openEvents(page: Page, spaceName: string) {
  await page.locator(`[data-nu-role="server-rail-item"][aria-label="${spaceName}"]`).click();
  await role(page, 'channel-list-events').click();
  await expect(role(page, 'calendar')).toBeVisible();
}

const memberEvent = (user: TestUser, spaceId: string) =>
  api<Record<string, unknown>>(user, 'GET', `/rooms/${enc(spaceId)}/state/m.room.member/${enc(user.userId)}`);

test('a moderator adds an event and a member RSVPs', async ({ browser }) => {
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  const { spaceId, spaceName } = await createSpaceWithChannel(alice, [bob]);
  await api(bob, 'PUT', `/profile/${enc(bob.userId)}/displayname`, { displayname: 'Bobby' });

  const alicePage = await (await browser.newContext()).newPage();
  await logIn(alicePage, alice);
  await openEvents(alicePage, spaceName);
  await role(alicePage, 'calendar-new-event').click();
  await role(alicePage, 'calendar-event-title').fill('Game night');
  await role(alicePage, 'calendar-event-save').click();
  const aliceCard = role(alicePage, 'calendar-event').filter({ hasText: 'Game night' });
  await expect(aliceCard).toContainText('0 going');

  const bobPage = await (await browser.newContext()).newPage();
  await logIn(bobPage, bob);
  await openEvents(bobPage, spaceName);
  // Members can't add events; moderators can.
  await expect(role(bobPage, 'calendar-new-event')).toHaveCount(0);
  const bobCard = role(bobPage, 'calendar-event').filter({ hasText: 'Game night' });
  await role(bobCard, 'calendar-rsvp-going').click();
  await expect(role(bobCard, 'calendar-rsvp-going')).toHaveAttribute('aria-pressed', 'true');
  await expect(aliceCard).toContainText('1 going');

  // The RSVP rides on Bob's own member event, which keeps everything else it had.
  const member = await eventually(
    () => memberEvent(bob, spaceId),
    (content) => !!content['xyz.nekous.rsvps']
  );
  expect(member.displayname).toBe('Bobby');
  expect(member.membership).toBe('join');
});

test('going to an event about to start brings up a reminder', async ({ browser }) => {
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  const { spaceId, spaceName } = await createSpaceWithChannel(alice, [bob]);
  await api(alice, 'PUT', `/rooms/${enc(spaceId)}/state/xyz.nekous.calendar_event/soon`, {
    title: 'Starting soon',
    start: Date.now() + 10 * 60 * 1000,
  });

  const bobPage = await (await browser.newContext()).newPage();
  await logIn(bobPage, bob);
  await openEvents(bobPage, spaceName);
  await role(role(bobPage, 'calendar-event').filter({ hasText: 'Starting soon' }), 'calendar-rsvp-going').click();
  await expect(role(bobPage, 'reminder').filter({ hasText: 'Starting soon' })).toBeVisible();
});

test('“Remind me” on a message, and a due reminder opening it', async ({ page }) => {
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  const { channelId, spaceName } = await createSpaceWithChannel(alice, [bob]);
  const eventId = await sendText(bob, channelId, 'remember the milk');

  await logIn(page, alice);
  await openChannel(page, spaceName, 'general');
  const target = message(page, 'remember the milk');
  await target.hover();
  await role(target, 'timeline-remind-action').click();
  await role(target, 'timeline-remind-choice').filter({ hasText: 'In 1 hour' }).click();
  const saved = await eventually(
    () => api<{ items?: { eventId: string; remindAt: number }[] }>(alice, 'GET', `/user/${enc(alice.userId)}/account_data/xyz.nekous.reminders`).catch(() => ({ items: [] })),
    (content) => (content.items ?? []).some((item) => item.eventId === eventId)
  );
  expect(saved.items![0].remindAt).toBeGreaterThan(Date.now() + 50 * 60 * 1000);

  // Make it due now, as if the hour had passed: it shows, and Open goes to the message.
  await api(alice, 'PUT', `/user/${enc(alice.userId)}/account_data/xyz.nekous.reminders`, {
    items: [{ ...saved.items![0], remindAt: Date.now() - 1000 }],
  });
  const reminder = role(page, 'reminder').filter({ hasText: 'remember the milk' });
  await expect(reminder).toBeVisible();
  await role(page, 'channel-list-feed').click();
  await role(reminder, 'reminder-open').click();
  await expect(message(page, 'remember the milk')).toBeVisible();
  // Shown once, then gone from every device.
  await eventually(
    () => api<{ items?: unknown[] }>(alice, 'GET', `/user/${enc(alice.userId)}/account_data/xyz.nekous.reminders`),
    (content) => (content.items ?? []).length === 0
  );
});
