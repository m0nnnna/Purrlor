import { expect, test } from '@playwright/test';
import { clickMessageAction, logIn, message, openChannel, role, send } from './app';
import { api, createSpaceWithChannel, createUser, eventually, latestEvents, sendText } from './matrix';

const enc = encodeURIComponent;

test('a thread: reply from a message, and another user’s reply arrives in it', async ({ page }) => {
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  const { channelId, spaceName } = await createSpaceWithChannel(alice, [bob]);
  const rootId = await sendText(alice, channelId, 'who is up for a thread?');

  await logIn(page, alice);
  await openChannel(page, spaceName, 'general');
  await clickMessageAction(message(page, 'who is up for a thread?'), 'timeline-thread-action');

  const panel = role(page, 'modal');
  await role(panel, 'composer-input').fill('first reply');
  await role(panel, 'composer-input').press('Enter');
  await expect(role(panel, 'thread-replies')).toContainText('first reply');

  // On the server it's a real thread reply, related to the root.
  await eventually(
    () => latestEvents(alice, channelId),
    (evs) => evs.some((e) => e.content.body === 'first reply' && e.content['m.relates_to']?.rel_type === 'm.thread' && e.content['m.relates_to']?.event_id === rootId)
  );

  // Bob replies from another client; it shows up in the open thread.
  await api(bob, 'PUT', `/rooms/${enc(channelId)}/send/m.room.message/${Date.now()}`, {
    msgtype: 'm.text',
    body: 'second reply from bob',
    'm.relates_to': { rel_type: 'm.thread', event_id: rootId, is_falling_back: true, 'm.in_reply_to': { event_id: rootId } },
  });
  await expect(role(panel, 'thread-replies')).toContainText('second reply from bob');
});

test('pinning a message lists it under Pinned, and unpinning removes it', async ({ page }) => {
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  const { channelId, spaceName } = await createSpaceWithChannel(alice, [bob]);
  const eventId = await sendText(bob, channelId, 'remember this one');

  await logIn(page, alice);
  await openChannel(page, spaceName, 'general');
  const target = message(page, 'remember this one');
  await clickMessageAction(target, 'timeline-pin-action');
  await expect(role(target, 'timeline-pinned-tag')).toBeVisible();

  const pinned = () => api<{ pinned?: string[] }>(alice, 'GET', `/rooms/${enc(channelId)}/state/m.room.pinned_events/`);
  await eventually(pinned, (state) => !!state.pinned?.includes(eventId));

  await role(page, 'main-pane-pins').click();
  await expect(role(page, 'pinned-messages-item')).toContainText('remember this one');
  await role(page, 'pinned-messages-unpin').click();
  await expect(role(page, 'pinned-messages-empty')).toBeVisible();
  await eventually(pinned, (state) => !state.pinned?.includes(eventId));
});

test('searching finds a message by a word in it and jumps to it', async ({ page }) => {
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  const { channelId, spaceName } = await createSpaceWithChannel(alice, [bob]);
  await sendText(bob, channelId, 'the marmalade recipe is in the drawer');
  await sendText(bob, channelId, 'nothing relevant here');

  await logIn(page, alice);
  await openChannel(page, spaceName, 'general');
  await role(page, 'main-pane-search').click();
  await role(page, 'message-search-input').fill('marmalade');
  const submit = role(page, 'modal').locator('button[type="submit"]');
  await submit.click();

  // The server indexes a moment after the message lands.
  await expect(async () => {
    await submit.click();
    await expect(role(page, 'search-result')).toHaveCount(1, { timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await expect(role(page, 'search-result')).toContainText('marmalade');

  await role(page, 'search-result').click();
  await expect(message(page, 'marmalade recipe')).toBeVisible();
});

test('a file picked in the composer uploads and is sent as a file message', async ({ page }) => {
  const alice = await createUser('alice');
  const { channelId, spaceName } = await createSpaceWithChannel(alice);

  await logIn(page, alice);
  await openChannel(page, spaceName, 'general');
  await role(page, 'composer-file-input').setInputFiles({ name: 'recipe.txt', mimeType: 'text/plain', buffer: Buffer.from('two cups of flour') });
  await expect(role(page, 'composer-attachment')).toContainText('recipe.txt');
  await role(page, 'composer-input').press('Enter');

  const events = await eventually(
    () => latestEvents(alice, channelId),
    (evs) => evs.some((e) => e.content.msgtype === 'm.file' && e.content.body === 'recipe.txt')
  );
  const file = events.find((e) => e.content.body === 'recipe.txt')!;
  expect(String(file.content.url)).toMatch(/^mxc:\/\//);
  expect(file.content.info?.size).toBe(17);
  // And a message typed with no file is unaffected.
  await send(page, 'and some words');
});
