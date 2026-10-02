import { expect, test, type Page } from '@playwright/test';
import { logIn, openApp, role } from './app';
import { createUser } from './matrix';

const TOKEN_SERVER = process.env.E2E_TOKEN_SERVER ?? 'http://127.0.0.1:6168';

/** The app's public API is the token server's; in a deployment nginx routes it there. */
async function routePublicApi(page: Page): Promise<void> {
  await page.route('**/api/public/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${TOKEN_SERVER}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
}

const countOf = async (page: Page) => Number((await role(page, 'online-count').locator('.nu-online-count__number').textContent())?.replace(/\D/g, ''));

test('the global feed says how many people are online, signed in and out', async ({ browser }, testInfo) => {
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  const alicePage = await (await browser.newContext()).newPage();
  await routePublicApi(alicePage);
  await logIn(alicePage, alice);
  await role(alicePage, 'server-rail-global-feed').click();
  await expect(role(alicePage, 'online-count')).toBeVisible();
  const before = await countOf(alicePage);
  expect(before).toBeGreaterThanOrEqual(1);

  // Bob opens the app: one more. (Other tests on this server may be online too, so it's relative.)
  const bobPage = await (await browser.newContext()).newPage();
  await routePublicApi(bobPage);
  await logIn(bobPage, bob);
  await role(bobPage, 'server-rail-global-feed').click();
  await expect(role(bobPage, 'online-count')).toBeVisible();
  expect(await countOf(bobPage)).toBeGreaterThanOrEqual(before + 1);
  await expect(role(bobPage, 'online-count')).toHaveAttribute('aria-label', /online now$/);
  await bobPage.screenshot({ path: testInfo.outputPath('feed-header.png'), clip: { x: 320, y: 0, width: 960, height: 120 } });

  // Signed out, the public feed shows the count too, without pinging.
  const visitor = await (await browser.newContext()).newPage();
  await routePublicApi(visitor);
  await openApp(visitor, '/feed');
  await expect(role(visitor, 'online-count')).toBeVisible();
  expect(await countOf(visitor)).toBeGreaterThanOrEqual(2);

  // And a ping without a real account's token counts no one.
  const bad = await fetch(`${TOKEN_SERVER}/api/public/online`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openid_token: { access_token: 'nope', matrix_server_name: 'localhost' } }),
  });
  expect(bad.status).toBe(401);
});
