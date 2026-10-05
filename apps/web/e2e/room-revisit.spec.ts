import { expect, test } from '@playwright/test';
import { logIn, message, openChannel, role } from './app';
import { api, createSpaceWithChannel, createUser, sendText } from './matrix';

const enc = encodeURIComponent;

/**
 * A room left scrolled up is opened again where it was left (MessageTimeline.tsx, roomViews), with
 * the same history drawn and nothing asked of the homeserver; one left at the bottom opens at the
 * bottom, as before.
 */
test('a channel left scrolled up opens again at the same message', async ({ page }) => {
  test.setTimeout(180_000);
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  const { spaceId, channelId, spaceName } = await createSpaceWithChannel(alice, [bob]);
  const { room_id: otherId } = await api<{ room_id: string }>(alice, 'POST', '/createRoom', {
    name: 'random',
    preset: 'public_chat',
    initial_state: [{ type: 'm.space.parent', state_key: spaceId, content: { via: ['localhost'], canonical: true } }],
  });
  await api(alice, 'PUT', `/rooms/${enc(spaceId)}/state/m.space.child/${enc(otherId)}`, { via: ['localhost'] });
  for (let i = 0; i < 90; i++) await sendText(bob, channelId, `line ${i}`);

  await logIn(page, alice);
  await openChannel(page, spaceName, 'general');
  await expect(message(page, 'line 89')).toBeInViewport();

  // Back through history with the wheel, as a reader would (which also ends the opening's settle
  // window, during which the view keeps to the bottom and doesn't fetch), far enough that the
  // message read below isn't near the top of what's loaded: that would fetch more on its own.
  const oldest = page.getByText('line 5', { exact: true });
  const target = message(page, 'line 40');
  await role(page, 'timeline').hover();
  await expect(async () => {
    await page.mouse.wheel(0, -5000);
    await expect(oldest).toBeAttached({ timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expect(target).toBeInViewport();
  await page.waitForTimeout(500);

  await openChannel(page, spaceName, 'random');
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(`/rooms/${enc(channelId)}/messages`)) asked.push(request.url());
  });
  await openChannel(page, spaceName, 'general');
  await expect(target).toBeInViewport();
  await expect(message(page, 'line 89')).not.toBeInViewport();
  expect(asked).toEqual([]);

  // Back to the bottom before leaving: it opens at the bottom.
  await role(page, 'timeline').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(500);
  await openChannel(page, spaceName, 'random');
  await openChannel(page, spaceName, 'general');
  await expect(message(page, 'line 89')).toBeInViewport();
});
