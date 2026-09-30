/* global process, console, fetch */
// Registers the homeserver's first account with Continuwuity's one-time bootstrap token (argv[2]),
// which switches on the configured registration token the tests use. Run by start-homeserver.sh.
const token = process.argv[2];
const url = 'http://127.0.0.1:6167/_matrix/client/v3/register';
const body = { username: 'e2e-admin', password: 'e2e-admin-password', inhibit_login: true };

const post = (extra) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...extra }) });

let res = await post({});
let data = await res.json();
if (res.status === 401) {
  res = await post({ auth: { type: 'm.login.registration_token', token, session: data.session } });
  data = await res.json();
}
if (!res.ok && data.errcode !== 'M_USER_IN_USE') {
  console.error('Bootstrap registration failed:', res.status, data);
  process.exit(1);
}
