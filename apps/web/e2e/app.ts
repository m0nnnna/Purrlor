import { expect, type Locator, type Page } from '@playwright/test';
import { HOMESERVER, type TestUser } from './matrix';

/**
 * Driving the app. Selectors are the `data-nu-role` attributes the components carry, which exist
 * for theming and tests and don't change with wording or layout.
 */

export const role = (page: Page | Locator, name: string) => page.locator(`[data-nu-role="${name}"]`);

/** Opens the app locked to the test homeserver, as a deployment's `/config.json` would. */
export async function openApp(page: Page): Promise<void> {
  await page.route('**/config.json', (route) => route.fulfill({ json: { homeserver: HOMESERVER } }));
  await page.goto('/');
}

export async function logIn(page: Page, user: TestUser): Promise<void> {
  await openApp(page);
  await expect(role(page, 'login-locked-homeserver')).toBeVisible();
  await page.getByLabel('Username').fill(user.localpart);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(role(page, 'server-rail')).toBeVisible();
}

export async function openChannel(page: Page, spaceName: string, channelName: string): Promise<void> {
  await page.locator(`[data-nu-role="server-rail-item"][aria-label="${spaceName}"]`).click();
  await role(page, 'channel-list-item').filter({ hasText: channelName }).click();
  await expect(role(page, 'composer-input')).toBeVisible();
}

export function message(page: Page, text: string): Locator {
  return role(page, 'timeline-message').filter({ hasText: text });
}

export async function send(page: Page, text: string): Promise<void> {
  const input = role(page, 'composer-input');
  await input.click();
  await input.fill(text);
  await input.press('Enter');
  await expect(message(page, text)).toBeVisible();
}
