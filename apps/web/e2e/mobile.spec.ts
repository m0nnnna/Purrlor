import { expect, test, devices, type Locator } from '@playwright/test';
import { logIn, message, role } from './app';
import { createSpaceWithChannel, createUser, sendText } from './matrix';

/**
 * The app on a phone (a touch screen, the one-pane layout): a message's actions open on a long
 * press, not left stuck open by a tap (there's no hover on a touch screen), and the page itself
 * never scrolls, so focusing the composer doesn't push the app up.
 */
test.use({ ...devices['iPhone 13'], browserName: 'chromium' } as never);

async function press(target: Locator, ms: number) {
  const box = (await target.boundingBox())!;
  const touch = { identifier: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await target.dispatchEvent('touchstart', { touches: [touch], changedTouches: [touch], targetTouches: [touch] });
  await target.page().waitForTimeout(ms);
  await target.dispatchEvent('touchend', { touches: [], changedTouches: [touch], targetTouches: [] });
}

const actionsVisible = (row: Locator) => row.locator('.nu-timeline__message-actions').evaluate((el) => getComputedStyle(el).opacity === '1');

test('on a phone, a message’s actions open on a long press, and the page stays put', async ({ page }) => {
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  const { channelId, spaceName } = await createSpaceWithChannel(alice, [bob]);
  await sendText(bob, channelId, 'hold me down');
  await sendText(bob, channelId, 'just below');
  await logIn(page, alice);
  await role(page, 'server-rail-item').filter({ hasText: spaceName.slice(0, 1) }).last().tap();
  await role(page, 'channel-list-item').filter({ hasText: 'general' }).first().tap();
  const row = message(page, 'hold me down');
  await expect(row).toBeVisible();

  await row.locator('.nu-timeline__message-text').tap();
  await page.waitForTimeout(300);
  expect(await actionsVisible(row)).toBe(false);

  await press(row.locator('.nu-timeline__message-text'), 700);
  await expect.poll(() => actionsVisible(row)).toBe(true);
  await expect(role(row, 'timeline-copy-action')).toBeVisible();

  // A touch anywhere else closes them.
  await press(message(page, 'just below').locator('.nu-timeline__message-text'), 50);
  await expect.poll(() => actionsVisible(row)).toBe(false);

  // The page itself doesn't scroll when the composer takes focus.
  await role(page, 'composer-input').tap();
  await page.keyboard.type('hi');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(role(page, 'main-pane-back')).toBeInViewport();
});
