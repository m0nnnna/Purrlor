import { expect, test, type Page } from '@playwright/test';
import { clickMessageAction, logIn, message, openChannel, role } from './app';
import { api, createSpaceWithChannel, createUser, eventually, latestEvents, sendText } from './matrix';

const enc = encodeURIComponent;

async function openReportsTab(page: Page) {
  await role(page, 'channel-list-settings').click();
  await role(page, 'space-settings-reports-tab').click();
  await expect(role(page, 'space-reports')).toBeVisible();
}

async function turnOnReportReview(page: Page) {
  await openReportsTab(page);
  await role(page, 'space-reports-setup').click();
  await expect(role(page, 'space-reports-empty')).toBeVisible();
}

test('a report reaches the Space’s moderators, who delete the message', async ({ browser }) => {
  const [alice, bob, dave] = await Promise.all([createUser('alice'), createUser('bob'), createUser('dave')]);
  const { channelId, spaceName } = await createSpaceWithChannel(alice, [bob, dave]);
  const spamId = await sendText(dave, channelId, 'buy followers at spam.example');

  // Alice owns the Space, so she moderates it: her client files the reports.
  const alicePage = await (await browser.newContext()).newPage();
  await logIn(alicePage, alice);
  await openChannel(alicePage, spaceName, 'general');
  await turnOnReportReview(alicePage);

  const bobPage = await (await browser.newContext()).newPage();
  await logIn(bobPage, bob);
  await openChannel(bobPage, spaceName, 'general');
  const spam = message(bobPage, 'buy followers');
  await clickMessageAction(spam, 'timeline-report-action');
  await expect(role(bobPage, 'report-dialog')).toContainText(`the moderators of ${spaceName}`);
  await role(bobPage, 'report-reason').fill('spam');
  await role(bobPage, 'report-submit').click();
  await expect(role(bobPage, 'report-sent')).toBeVisible();

  const report = role(alicePage, 'space-report').filter({ hasText: 'buy followers' });
  await expect(report).toContainText('spam');
  await role(report, 'space-report-delete').click();
  await expect(role(report, 'space-report-resolution')).toContainText('Message deleted');

  await eventually(
    () => latestEvents(alice, channelId),
    (evs) => {
      const original = evs.find((e) => e.event_id === spamId);
      return !!original && Object.keys(original.content).length === 0;
    }
  );
});

test('automod: blocked words are refused, and deleted when sent from elsewhere', async ({ browser }) => {
  const [alice, bob, dave] = await Promise.all([createUser('alice'), createUser('bob'), createUser('dave')]);
  const { spaceId, channelId, spaceName } = await createSpaceWithChannel(alice, [bob, dave]);

  const alicePage = await (await browser.newContext()).newPage();
  await logIn(alicePage, alice);
  await openChannel(alicePage, spaceName, 'general');
  await turnOnReportReview(alicePage);
  await role(alicePage, 'space-automod-words').fill('Bananas');
  await role(alicePage, 'space-automod-save').click();
  await eventually(
    () => api<{ blocked_words?: string[] }>(alice, 'GET', `/rooms/${enc(spaceId)}/state/xyz.nekous.moderation/`),
    (content) => content.blocked_words?.includes('Bananas') ?? false
  );

  // In Purrlor, the message isn't sent at all.
  const bobPage = await (await browser.newContext()).newPage();
  await logIn(bobPage, bob);
  await openChannel(bobPage, spaceName, 'general');
  const input = role(bobPage, 'composer-input');
  await input.fill('I love bananas!');
  await input.press('Enter');
  await expect(role(bobPage, 'composer-command-error')).toContainText('isn’t allowed');
  await expect(input).toHaveValue('I love bananas!');

  // From another app it is, and the moderator's client deletes it and files it.
  const sneakyId = await sendText(dave, channelId, 'BANANAS forever');
  await eventually(
    () => latestEvents(alice, channelId),
    (evs) => {
      const original = evs.find((e) => e.event_id === sneakyId);
      return !!original && Object.keys(original.content).length === 0;
    }
  );
  await expect(role(alicePage, 'space-report').filter({ hasText: 'Automod' })).toContainText('deleted');
});
