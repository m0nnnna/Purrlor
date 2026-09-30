import { expect, test } from '@playwright/test';
import { logIn, role } from './app';
import { api, createSpaceWithChannel, createUser, eventually } from './matrix';

type Rules = { global: { override?: { rule_id: string }[]; room?: { rule_id: string }[] } };

const hasRule = (rules: Rules, kind: 'override' | 'room', roomId: string) =>
  (rules.global[kind] ?? []).some((rule) => rule.rule_id === roomId);

test('channel and Space notification levels become push rules', async ({ page }) => {
  const alice = await createUser('alice');
  const { channelId, spaceName } = await createSpaceWithChannel(alice);
  const rules = () => api<Rules>(alice, 'GET', '/pushrules/');

  await logIn(page, alice);
  await page.locator(`[data-nu-role="server-rail-item"][aria-label="${spaceName}"]`).click();

  // The whole Space to "Only @mentions": a room rule on its channel.
  await role(page, 'space-notification-menu').click();
  await role(page, 'space-notification-mentions').click();
  await eventually(rules, (r) => hasRule(r, 'room', channelId) && !hasRule(r, 'override', channelId));
  const row = role(page, 'channel-list-item').filter({ hasText: 'general' });
  await expect(role(row, 'channel-list-item-level')).toHaveAttribute('title', 'Notifications: Only @mentions');

  // The channel to "Nothing": an override instead, and the row dims.
  await row.hover();
  await role(page, 'room-notification-menu').click();
  await role(page, 'room-notification-nothing').click();
  await eventually(rules, (r) => hasRule(r, 'override', channelId) && !hasRule(r, 'room', channelId));
  await expect(row).toHaveClass(/nu-channel-list__item--muted/);

  // Back to the Space's level, then the Space back to the default: no rules left.
  await row.hover();
  await role(page, 'room-notification-menu').click();
  await role(page, 'room-notification-inherit').click();
  await eventually(rules, (r) => hasRule(r, 'room', channelId) && !hasRule(r, 'override', channelId));
  await role(page, 'space-notification-menu').click();
  await role(page, 'space-notification-all').click();
  await eventually(rules, (r) => !hasRule(r, 'room', channelId) && !hasRule(r, 'override', channelId));
  await expect(role(row, 'channel-list-item-level')).toHaveCount(0);
});
