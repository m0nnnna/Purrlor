import { expect, test } from '@playwright/test';
import { logIn, openApp, role } from './app';
import { HOMESERVER, uniqueName, type TestUser } from './matrix';

type KeysQuery = {
  device_keys: Record<string, Record<string, { signatures?: Record<string, Record<string, string>> }>>;
  self_signing_keys?: Record<string, { keys: Record<string, string> }>;
};

async function logInByApi(localpart: string, password: string): Promise<TestUser & { deviceId: string }> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: localpart }, password }),
  });
  const data = (await res.json()) as { user_id: string; access_token: string; device_id: string };
  return { userId: data.user_id, localpart, password, accessToken: data.access_token, deviceId: data.device_id };
}

/** Every device of the user, and whether the account's self-signing key has signed it: what
 *  other Matrix apps (Element, FluffyChat) check to call a session verified. */
async function crossSignedDevices(user: TestUser): Promise<Record<string, boolean>> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/keys/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.accessToken}` },
    body: JSON.stringify({ device_keys: { [user.userId]: [] } }),
  });
  const data = (await res.json()) as KeysQuery;
  const selfSigningKeyIds = Object.keys(data.self_signing_keys?.[user.userId]?.keys ?? {});
  return Object.fromEntries(
    Object.entries(data.device_keys[user.userId] ?? {}).map(([deviceId, device]) => [
      deviceId,
      selfSigningKeyIds.some((keyId) => !!device.signatures?.[user.userId]?.[keyId]),
    ])
  );
}

test('a new session verified with the recovery key is cross-signed, so other apps trust it', async ({ browser }) => {
  // Registering in the app sets up cross-signing and secret storage, and shows the recovery key.
  const localpart = uniqueName('verify').toLowerCase();
  const password = `pw-${localpart}`;
  const first = await (await browser.newContext()).newPage();
  await openApp(first);
  await first.getByRole('button', { name: 'Need an account? Register' }).click();
  await first.getByLabel('Username').fill(localpart);
  await first.getByLabel('Password', { exact: true }).fill(password);
  await first.getByLabel('Confirm password').fill(password);
  await first.getByRole('button', { name: 'Create account' }).click();
  await role(first, 'register-token-form').getByLabel('Token').fill(process.env.E2E_REGISTRATION_TOKEN ?? 'e2e-registration-token');
  await role(first, 'register-token-form').getByRole('button', { name: 'Continue' }).click();
  const recoveryKey = (await role(first, 'recovery-setup-key').textContent({ timeout: 60_000 }))?.trim() ?? '';
  expect(recoveryKey.length).toBeGreaterThan(20);

  // A second session: it asks to be verified, and the recovery key does it.
  const user = await logInByApi(localpart, password);
  const second = await (await browser.newContext()).newPage();
  await logIn(second, user);
  await expect(role(second, 'recovery-prompt')).toBeVisible();
  await role(second, 'recovery-prompt-input').fill(recoveryKey);
  await second.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(role(second, 'recovery-prompt-success')).toContainText('This session is verified');

  // Both sessions the app made are now signed by the account's self-signing key. (The one the
  // test logged in over the API has no device keys, so it isn't listed.)
  const signed = await crossSignedDevices(user);
  const appSessions = Object.entries(signed).filter(([deviceId]) => deviceId !== user.deviceId);
  expect(appSessions).toHaveLength(2);
  expect(appSessions.every(([, isSigned]) => isSigned)).toBe(true);
});
