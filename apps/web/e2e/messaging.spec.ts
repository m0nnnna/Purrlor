import { expect, test } from '@playwright/test';
import { clickMessageAction, logIn, message, openChannel, role, send } from './app';
import { createSpaceWithChannel, createUser, eventually, latestEvents, sendText } from './matrix';

test('sign in, send a message, and see a reply arrive', async ({ page }) => {
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  const { channelId, spaceName } = await createSpaceWithChannel(alice, [bob]);

  await logIn(page, alice);
  await openChannel(page, spaceName, 'general');

  await send(page, 'hello from the browser');
  const events = await eventually(
    () => latestEvents(bob, channelId),
    (evs) => evs.some((e) => e.type === 'm.room.message' && e.content.body === 'hello from the browser')
  );
  expect(events.find((e) => e.content.body === 'hello from the browser')?.sender).toBe(alice.userId);

  await sendText(bob, channelId, 'hi alice, got it');
  await expect(message(page, 'hi alice, got it')).toBeVisible();
});

test('react to a message', async ({ page }) => {
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  const { channelId, spaceName } = await createSpaceWithChannel(alice, [bob]);
  const eventId = await sendText(bob, channelId, 'react to this');

  await logIn(page, alice);
  await openChannel(page, spaceName, 'general');

  const target = message(page, 'react to this');
  await clickMessageAction(target, 'reaction-picker-toggle');
  await role(target, 'reaction-picker-panel').getByRole('button', { name: '👍' }).click();
  await expect(role(target, 'reaction-pill')).toContainText('1');

  await eventually(
    () => latestEvents(bob, channelId),
    (evs) =>
      evs.some(
        (e) => e.type === 'm.reaction' && e.sender === alice.userId && e.content['m.relates_to']?.event_id === eventId && e.content['m.relates_to']?.key === '👍'
      )
  );
});
