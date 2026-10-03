#!/usr/bin/env node
// Checks the homeserver behaviour Purrlor's federation rests on, between two real servers
// (docs/federation.md, and "Verify first" in the plan). Nothing here is Purrlor-specific beyond the
// event and room types: it talks to the two homeservers' client APIs as three test accounts.
//
//   A_HS=https://matrix.purr.example A_USER=fedtest1 A_PASS=… A2_USER=fedtest2 A2_PASS=… \
//   B_HS=https://matrix.cats.example B_USER=fedtest B_PASS=… \
//   node deploy/federation-check.mjs
//
// Before running: on server B, sign in as B_USER in Purrlor, make a Global post (with a picture),
// and give the account an avatar. A_USER and A2_USER are two ordinary accounts on server A that have
// never opened B_USER's profile. Needs Node 18 or newer; installs nothing.
//
// It changes a little on purpose: A2 joins B_USER's profile room, A likes B_USER's newest post and
// then takes the like back. Use test accounts.

const env = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name} (see the top of this file).`);
    process.exit(2);
  }
  return value;
};

const A_HS = env('A_HS').replace(/\/+$/, '');
const B_HS = env('B_HS').replace(/\/+$/, '');
const PROFILE_ROOM_TYPE = 'xyz.nekous.profile';
const PROFILE_ROOM_KEY = 'xyz.nekous.profile_room';
const POST = 'xyz.nekous.post';

const results = [];
const record = (name, ok, detail, ifNot) => {
  results.push({ name, ok, detail, ifNot });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};

async function login(hs, user, password) {
  const res = await fetch(`${hs}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user }, password, initial_device_display_name: 'federation-check' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Couldn't sign in as ${user} on ${hs}: ${body.error ?? res.status}`);
  return { hs, token: body.access_token, userId: body.user_id };
}

async function call(who, method, path, body) {
  const res = await fetch(`${who.hs}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, ok: res.ok, json, text };
}

const enc = encodeURIComponent;
const serverOf = (id) => id.slice(id.indexOf(':') + 1);

async function main() {
  const a = await login(A_HS, env('A_USER'), env('A_PASS'));
  const a2 = await login(A_HS, env('A2_USER'), env('A2_PASS'));
  const b = await login(B_HS, env('B_USER'), env('B_PASS'));
  const bServer = serverOf(b.userId);
  console.log(`A: ${a.userId} and ${a2.userId} on ${A_HS}\nB: ${b.userId} on ${B_HS}\n`);

  // B's profile room, from B's own side (the truth to compare against).
  const own = await call(b, 'GET', `/_matrix/client/v3/user/${enc(b.userId)}/account_data/${enc(PROFILE_ROOM_KEY)}`);
  const profileRoom = own.json?.roomId;
  if (!profileRoom) {
    console.error(`${b.userId} has no profile room yet: make a Global post as them in Purrlor first.`);
    process.exit(2);
  }

  // 1. Remote extended profile: A asks its own homeserver about B's person.
  const profile = await call(a, 'GET', `/_matrix/client/v3/profile/${enc(b.userId)}`);
  record(
    '1. Remote extended profiles: Purrlor fields come through federation',
    profile.json?.[PROFILE_ROOM_KEY] === profileRoom,
    profile.ok ? `A sees ${PROFILE_ROOM_KEY} = ${profile.json?.[PROFILE_ROOM_KEY] ?? '(missing)'}; B has ${profileRoom}` : `HTTP ${profile.status}: ${profile.text.slice(0, 200)}`,
    "The client finds a peer's person's profile room through the peer's directory instead."
  );

  // 2. Remote directory, filtered by room type.
  const dir = await call(a, 'POST', `/_matrix/client/v3/publicRooms?server=${enc(bServer)}`, {
    limit: 100,
    filter: { room_types: [PROFILE_ROOM_TYPE, 'm.space'] },
  });
  const entries = dir.json?.chunk ?? [];
  const listed = entries.find((entry) => entry.room_id === profileRoom);
  const typesOk = entries.every((entry) => entry.room_type === PROFILE_ROOM_TYPE || entry.room_type === 'm.space');
  record(
    "2. Remote directories by room type: B's profile rooms and Spaces, with their types",
    dir.ok && !!listed && listed.room_type === PROFILE_ROOM_TYPE,
    dir.ok
      ? `${entries.length} entries; B's profile room ${listed ? `listed with room_type ${listed.room_type ?? '(none)'}` : 'not listed'}; filter ${typesOk ? 'applied' : 'ignored (other types came back)'}`
      : `HTTP ${dir.status}: ${dir.text.slice(0, 200)}`,
    "If entries lack room_type, the bot can't tell profile rooms from others: it would have to read each room's state."
  );

  // 3. Reading as a non-member, once someone on A has joined.
  const before = await call(a, 'GET', `/_matrix/client/v3/rooms/${enc(profileRoom)}/messages?dir=b&limit=5`);
  const join = await call(a2, 'POST', `/_matrix/client/v3/join/${enc(profileRoom)}?server_name=${enc(bServer)}`, {});
  if (!join.ok) {
    record('3. Reading as a non-member after a local join', false, `A2 couldn't join B's profile room: HTTP ${join.status}: ${join.text.slice(0, 200)}`, 'The bot could not join peers either: federation between the two servers is the first thing to fix.');
  } else {
    let after;
    for (let i = 0; i < 10; i += 1) {
      after = await call(a, 'GET', `/_matrix/client/v3/rooms/${enc(profileRoom)}/messages?dir=b&limit=20`);
      if (after.ok && (after.json?.chunk ?? []).some((event) => event.type === POST)) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const state = await call(a, 'GET', `/_matrix/client/v3/rooms/${enc(profileRoom)}/state`);
    const posts = (after?.json?.chunk ?? []).filter((event) => event.type === POST);
    record(
      '3. Reading as a non-member: A reads B\'s profile room once A2 (same server) has joined',
      !!after?.ok && posts.length > 0 && state.ok,
      `before the join: HTTP ${before.status}; after: /messages HTTP ${after?.status} with ${posts.length} post(s), /state HTTP ${state.status}`,
      "The bot's joins wouldn't make peers readable for everyone: every reader would have to join (or the client reads through the token server)."
    );
  }

  // 4. Interacting: A joins, likes B's newest post, and B sees it.
  const aJoin = await call(a, 'POST', `/_matrix/client/v3/join/${enc(profileRoom)}?server_name=${enc(bServer)}`, {});
  const newest = (await call(b, 'GET', `/_matrix/client/v3/rooms/${enc(profileRoom)}/messages?dir=b&limit=50`)).json?.chunk?.find((event) => event.type === POST);
  if (!aJoin.ok || !newest) {
    record('4. Interacting: A likes B\'s post and B sees it', false, !aJoin.ok ? `A couldn't join: HTTP ${aJoin.status}` : "B's profile room has no post", '');
  } else {
    const like = await call(a, 'PUT', `/_matrix/client/v3/rooms/${enc(profileRoom)}/send/m.reaction/fedcheck${Date.now()}`, {
      'm.relates_to': { rel_type: 'm.annotation', event_id: newest.event_id, key: '❤️' },
    });
    let seen = false;
    for (let i = 0; i < 15 && like.ok && !seen; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const rel = await call(b, 'GET', `/_matrix/client/v1/rooms/${enc(profileRoom)}/relations/${enc(newest.event_id)}/m.annotation?limit=50`);
      seen = (rel.json?.chunk ?? []).some((event) => event.event_id === like.json?.event_id);
    }
    record(
      "4. Interacting: A likes B's post and B's server has it",
      like.ok && seen,
      like.ok ? (seen ? 'the like arrived on B' : 'sent, but B had not received it after 30s') : `HTTP ${like.status}: ${like.text.slice(0, 200)}`,
      'Likes and comments from peers would not reach the author.'
    );
    if (like.ok) await call(a, 'PUT', `/_matrix/client/v3/rooms/${enc(profileRoom)}/redact/${enc(like.json.event_id)}/fedcheck-undo${Date.now()}`, { reason: 'federation-check' });
    console.log('      (also check by hand: did B get a notification for the like?)');
  }

  // 5. Remote media through A's homeserver.
  const avatar = (await call(b, 'GET', `/_matrix/client/v3/profile/${enc(b.userId)}`)).json?.avatar_url;
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(avatar ?? '');
  if (!match) {
    record("5. Remote media: B's avatar through A's homeserver", false, `${b.userId} has no avatar: give them one and run this again.`, '');
  } else {
    const media = await call(a, 'GET', `/_matrix/client/v1/media/thumbnail/${enc(match[1])}/${enc(match[2])}?width=64&height=64&method=scale`);
    record(
      "5. Remote media: B's avatar through A's homeserver (authenticated media over federation)",
      media.ok,
      `HTTP ${media.status}`,
      "Peers' avatars, pictures and music wouldn't load here."
    );
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed.`);
  for (const result of failed) if (result.ifNot) console.log(`- ${result.name.split(':')[0]} failed: ${result.ifNot}`);
  console.log('\nThe test sessions stay signed in; sign them out in each account\'s Sessions settings if you like.');
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
