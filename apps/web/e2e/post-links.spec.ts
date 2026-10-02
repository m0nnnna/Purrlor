import { expect, test, type Page } from '@playwright/test';
import { logIn, openApp, role } from './app';
import { api, createUser, uniqueName } from './matrix';

/**
 * Sharing a Global post: "Copy link" gives `/@name/post/<id>`, which opens that post's page for
 * someone signed in and the public post for someone who isn't, with a link preview. A post older
 * than the public web's window (each profile's latest 100 events) still opens, found from the
 * link's author.
 */

const TOKEN_SERVER = process.env.E2E_TOKEN_SERVER ?? 'http://127.0.0.1:6168';

async function routePublicApi(page: Page): Promise<void> {
  await page.route('**/api/public/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${TOKEN_SERVER}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
}

test('a Global post’s link opens it signed in and signed out, however old it is', async ({ browser }) => {
  test.setTimeout(180_000);
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  const aliceContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await aliceContext.newPage();
  await logIn(page, alice);

  const text = uniqueName('share me');
  await role(page, 'server-rail-global-feed').click();
  await role(page, 'feed-composer-input').fill(text);
  await role(page, 'feed-composer-submit').click();
  const post = role(page, 'global-feed-post').filter({ hasText: text });
  await expect(post).toBeVisible();

  await role(post, 'post-more').click();
  await expect(role(page, 'post-copy-link')).toHaveText('Copy link');
  await role(page, 'post-copy-link').click();
  await expect(role(post, 'post-link-notice')).toHaveText('Link copied.');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(new RegExp(`^${new URL(page.url()).origin}/@${alice.localpart}/post/%24[^?]+$`));
  const eventId = decodeURIComponent(new URL(link).pathname.split('/').pop() ?? '');

  // Bury it: more than the public web reads of Alice's profile room (its latest 100 events).
  const { roomId } = await api<{ roomId: string }>(alice, 'GET', `/user/${encodeURIComponent(alice.userId)}/account_data/xyz.nekous.profile_room`);
  for (let i = 0; i < 105; i += 1) {
    await api(alice, 'PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${uniqueName('txn')}`, {
      'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key: `${i}` },
    });
  }

  // Signed in (Bob): the link opens the post's own page.
  const bobContext = await browser.newContext();
  const bobPage = await bobContext.newPage();
  await logIn(bobPage, bob);
  await bobPage.goto(link);
  await expect(role(bobPage, 'post-page')).toContainText(text, { timeout: 30_000 });

  // Signed out: the public post, though it's past the public feed's window, and its preview.
  // Once the service has read the buried room again: not in its feed, so found only through the author.
  const postUrl = `${TOKEN_SERVER}/api/public/posts/${encodeURIComponent(eventId)}`;
  // Every few seconds: the public API is rate limited per address, and other tests poll it too.
  await expect
    .poll(async () => [(await fetch(postUrl)).status, (await fetch(`${postUrl}?author=${alice.localpart}`)).status], {
      timeout: 120_000,
      intervals: [3000],
    })
    .toEqual([404, 200]);
  const visitor = await browser.newContext();
  const visitorPage = await visitor.newPage();
  await routePublicApi(visitorPage);
  await openApp(visitorPage, new URL(link).pathname);
  await expect(role(visitorPage, 'public-post-view')).toContainText(text, { timeout: 30_000 });
  const card = await (await fetch(`${TOKEN_SERVER}/api/public/card/post/${encodeURIComponent(eventId)}?author=${alice.localpart}`)).text();
  expect(card).toContain(text);

  await Promise.all([aliceContext.close(), bobContext.close(), visitor.close()]);
});
