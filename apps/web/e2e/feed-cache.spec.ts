import { expect, test } from '@playwright/test';
import { logIn, role } from './app';
import { api, createUser, eventually, uniqueName } from './matrix';

const enc = encodeURIComponent;
const FEED_READS = /\/_matrix\/client\/v3\/(publicRooms|rooms\/[^/]+\/(messages|state))/;

/**
 * The feed keeps the timeline it last showed on the device (matrix/feedSnapshot.ts): opened again in
 * a new session, its posts are there before the homeserver has answered anything, and then only
 * what's new is asked for: no directory or `/state` reads while the list of feeds is recent, and
 * each feed's newest posts rather than a page of it.
 */
test('the feed shows its last posts at once after a reload, then asks only for what’s new', async ({ page }) => {
  test.setTimeout(180_000);
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  // Bob's profile room, made by posting through the app, so it's listed like anyone's.
  const bobPage = await (await page.context().browser()!.newContext()).newPage();
  await logIn(bobPage, bob);
  await role(bobPage, 'server-rail-global-feed').click();
  const first = uniqueName('kept post');
  await role(bobPage, 'feed-composer-input').fill(first);
  await role(bobPage, 'feed-composer-submit').click();
  const { roomId } = (await eventually(
    () => api<{ roomId?: string }>(bob, 'GET', `/user/${enc(bob.userId)}/account_data/xyz.nekous.profile_room`).catch(() => ({ roomId: undefined })),
    (data) => !!data.roomId
  )) as { roomId: string };
  await bobPage.close();

  await logIn(page, alice);
  await role(page, 'server-rail-global-feed').click();
  const post = role(page, 'global-feed-post').filter({ hasText: first });
  await expect(post).toBeVisible({ timeout: 30_000 });
  await expect(role(page, 'global-feed-loading')).toHaveCount(0, { timeout: 30_000 });
  // Long enough for the timeline to settle and be kept, and (JUST_READ_MS) to be worth asking about.
  await page.waitForTimeout(31_000);

  // Bob posts again while Alice is away.
  const later = uniqueName('later post');
  await api(bob, 'PUT', `/rooms/${enc(roomId)}/send/xyz.nekous.post/${uniqueName('txn')}`, { body: later });

  // After the reload, every read that gathers the feed is held back at first, and noted.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const asked: string[] = [];
  await page.route(FEED_READS, async (route) => {
    asked.push(decodeURIComponent(route.request().url()));
    await held;
    await route.continue();
  });
  await page.reload();
  await role(page, 'server-rail-global-feed').click();
  await expect(post).toBeVisible({ timeout: 10_000 });

  release();
  await expect(role(page, 'global-feed-post').filter({ hasText: later })).toBeVisible({ timeout: 30_000 });
  await expect(role(page, 'global-feed-loading')).toHaveCount(0, { timeout: 30_000 });
  await page.unroute(FEED_READS);

  // Nothing gathered again (the feeds were listed moments ago), and Bob's feed asked only for its
  // newest posts.
  expect(asked.filter((url) => url.includes('/publicRooms') || /\/state(\?|$)/.test(url))).toEqual([]);
  const bobReads = asked.filter((url) => url.includes(`/rooms/${roomId}/messages`));
  expect(bobReads.length).toBeGreaterThan(0);
  expect(bobReads.every((url) => url.includes('"types":["xyz.nekous.post"]'))).toBe(true);
});
