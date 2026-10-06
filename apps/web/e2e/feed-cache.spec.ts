import { expect, test } from '@playwright/test';
import { logIn, role } from './app';
import { api, createUser, eventually, uniqueName } from './matrix';

const enc = encodeURIComponent;

/**
 * The feed keeps the timeline it last showed on the device (matrix/feedSnapshot.ts): opened again in
 * a new session, its posts are there before the homeserver has answered any of the reads that
 * gather them (the directory, every feed's state and history; for a peer's people, all of it over
 * federation). The fresh read still runs and replaces it.
 */
test('the feed shows its last posts at once after a reload, before the server answers', async ({ page }) => {
  test.setTimeout(180_000);
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  // Bob's profile room, made by posting through the app, so it's listed like anyone's.
  const bobPage = await (await page.context().browser()!.newContext()).newPage();
  await logIn(bobPage, bob);
  await role(bobPage, 'server-rail-global-feed').click();
  const first = uniqueName('kept post');
  await role(bobPage, 'feed-composer-input').fill(first);
  await role(bobPage, 'feed-composer-submit').click();
  await eventually(
    () => api<{ roomId?: string }>(bob, 'GET', `/user/${enc(bob.userId)}/account_data/xyz.nekous.profile_room`).catch(() => ({ roomId: undefined })),
    (data) => !!data.roomId
  );
  await bobPage.close();

  await logIn(page, alice);
  await role(page, 'server-rail-global-feed').click();
  const post = role(page, 'global-feed-post').filter({ hasText: first });
  await expect(post).toBeVisible({ timeout: 30_000 });
  // Long enough for the timeline to settle and be kept.
  await page.waitForTimeout(3000);

  // Every read that gathers the feed is held back after the reload.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  let heldBack = 0;
  await page.route(/\/_matrix\/client\/v3\/(publicRooms|rooms\/[^/]+\/(messages|state))/, async (route) => {
    heldBack += 1;
    await held;
    await route.continue();
  });
  await page.reload();
  await role(page, 'server-rail-global-feed').click();
  await expect(post).toBeVisible({ timeout: 10_000 });
  expect(heldBack).toBeGreaterThan(0);
  await expect(role(page, 'global-feed-loading')).toBeVisible();

  // And the fresh read still lands behind it.
  release();
  await page.unroute(/\/_matrix\/client\/v3\/(publicRooms|rooms\/[^/]+\/(messages|state))/);
  await expect(role(page, 'global-feed-loading')).toHaveCount(0, { timeout: 30_000 });
  await expect(post).toBeVisible();
});
