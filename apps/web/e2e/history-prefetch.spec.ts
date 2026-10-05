import { expect, test } from '@playwright/test';
import { logIn, openChannel, role } from './app';
import { api, createSpaceWithChannel, createUser, sendText, uniqueName } from './matrix';

/**
 * A room's recent history is fetched in the background after start (matrix/historyPrefetch.ts),
 * so opening it shows its messages without waiting on the homeserver: here a channel whose latest
 * events are all state changes, which used to open empty and fetch page after page.
 */
test('a channel buried under state changes opens with its messages, nothing left to fetch', async ({ page }) => {
  test.setTimeout(180_000);
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  const { channelId, spaceName } = await createSpaceWithChannel(alice, [bob]);
  for (let i = 0; i < 20; i++) await sendText(bob, channelId, `old news ${i}`);
  // 60 topic changes on top: more than the 30 events a room comes with from sync.
  for (let i = 0; i < 60; i++) {
    await api(alice, 'PUT', `/rooms/${encodeURIComponent(channelId)}/state/m.room.topic/`, { topic: uniqueName('topic') });
  }

  await logIn(page, alice);
  // The background fill starts a moment after the app is up.
  await page.waitForTimeout(6000);
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/messages')) asked.push(request.url());
  });
  await openChannel(page, spaceName, 'general');
  await expect(role(page, 'timeline-message').filter({ hasText: 'old news 19' })).toBeVisible({ timeout: 2000 });
  expect(asked).toEqual([]);
});
