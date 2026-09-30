/* global process, console, fetch */
// Registers the homeserver's first account with Continuwuity's one-time bootstrap token (argv[2]),
// which switches on the configured registration token the tests use, then the token server's bot
// with that token. Run by start-homeserver.sh.
const token = process.argv[2];
const url = 'http://127.0.0.1:6167/_matrix/client/v3/register';
async function register(username, password, registrationToken) {
  const body = { username, password, inhibit_login: true };
  const post = (extra) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...extra }) });
  let res = await post({});
  let data = await res.json();
  if (res.status === 401) {
    res = await post({ auth: { type: 'm.login.registration_token', token: registrationToken, session: data.session } });
    data = await res.json();
  }
  if (!res.ok && data.errcode !== 'M_USER_IN_USE') {
    console.error(`Registering ${username} failed:`, res.status, data);
    process.exit(1);
  }
}

await register('e2e-admin', 'e2e-admin-password', token);
await register('e2e-bot', 'e2e-bot-password', 'e2e-registration-token');
