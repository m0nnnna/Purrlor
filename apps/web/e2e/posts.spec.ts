import { expect, test } from '@playwright/test';
import { logIn, role } from './app';
import { api, createSpaceWithChannel, createUser, eventually, latestEvents } from './matrix';

test('publish a post to a Space', async ({ page }) => {
  const alice = await createUser('alice');
  const { spaceId, spaceName } = await createSpaceWithChannel(alice);

  await logIn(page, alice);
  await page.locator(`[data-nu-role="server-rail-item"][aria-label="${spaceName}"]`).click();
  await role(page, 'channel-list-feed').click();

  // The first post also creates your feed room in this Space (matrix/feed.ts).
  await role(page, 'feed-composer-input').fill('my first post');
  await role(page, 'feed-composer-submit').click();
  await expect(role(page, 'feed-post').filter({ hasText: 'my first post' })).toBeVisible();

  const feeds = await eventually(
    () =>
      api<Record<string, string>>(alice, 'GET', `/user/${encodeURIComponent(alice.userId)}/account_data/xyz.nekous.feed_rooms`).catch(
        (): Record<string, string> => ({})
      ),
    (value) => !!value[spaceId]
  );
  const events = await eventually(
    () => latestEvents(alice, feeds[spaceId]),
    (evs) => evs.some((e) => e.type === 'xyz.nekous.post')
  );
  expect(JSON.stringify(events.find((e) => e.type === 'xyz.nekous.post')?.content)).toContain('my first post');
});
