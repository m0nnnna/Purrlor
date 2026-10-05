import { expect, test } from '@playwright/test';
import { logIn, role } from './app';
import { api, createUser, eventually, uniqueName } from './matrix';

const enc = encodeURIComponent;

/**
 * The global feed holds back posts that arrive while you're reading ("N new posts") and shows them
 * on a press. Only posts that really just arrived: history fetched further back (rooms filling in
 * the background) used to count too, and old posts pressed in sorted far down, so the button
 * seemed to do nothing.
 */
test('"new posts" counts only new posts, and pressing it shows them at the top', async ({ page }) => {
  test.setTimeout(180_000);
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  const bobPage = await (await page.context().browser()!.newContext()).newPage();
  await logIn(bobPage, bob);
  await role(bobPage, 'server-rail-global-feed').click();
  await role(bobPage, 'feed-composer-input').fill(uniqueName('bob first'));
  await role(bobPage, 'feed-composer-submit').click();
  const { roomId } = (await eventually(
    () => api<{ roomId?: string }>(bob, 'GET', `/user/${enc(bob.userId)}/account_data/xyz.nekous.profile_room`).catch(() => ({ roomId: undefined })),
    (data) => !!data.roomId
  )) as { roomId: string };
  // Plenty of older posts: more than a room comes with from sync, so there's history behind them.
  const older = uniqueName('older');
  for (let i = 0; i < 40; i++) await api(bob, 'PUT', `/rooms/${enc(roomId)}/send/xyz.nekous.post/${uniqueName('txn')}`, { body: `${older} #${i}#` });
  await bobPage.close();
  // Alice is in Bob's profile room (as when following someone), so it updates live, and her app
  // has history behind its latest events to fetch.
  await api(alice, 'POST', `/join/${enc(roomId)}`, {});

  await logIn(page, alice);
  await role(page, 'server-rail-global-feed').click();
  await expect(role(page, 'global-feed-post').filter({ hasText: `${older} #39#` })).toBeVisible({ timeout: 30_000 });
  // Long enough for the background history fill to have run.
  await page.waitForTimeout(8000);
  await expect(role(page, 'global-feed-new-posts')).toHaveCount(0);

  const fresh = uniqueName('just now');
  await api(bob, 'PUT', `/rooms/${enc(roomId)}/send/xyz.nekous.post/${uniqueName('txn')}`, { body: fresh });
  const pill = role(page, 'global-feed-new-posts');
  await expect(pill).toHaveText(/1 new post/, { timeout: 30_000 });
  await pill.click();
  await expect(pill).toHaveCount(0);
  await expect(role(page, 'global-feed-post').first()).toContainText(fresh);
});
