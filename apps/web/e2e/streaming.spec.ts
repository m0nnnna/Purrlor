import { expect, test, type Browser, type Page } from '@playwright/test';
import { logIn, openApp, openOwnProfile, role } from './app';
import { api, createUser, eventually, sendText, type TestUser } from './matrix';

/**
 * Live streams (docs/streaming.md) through the real token server and LiveKit: someone goes live
 * from their profile, a signed-in viewer watches on the watch page and chats, a signed-out visitor
 * watches and reads the chat but can't write, and ending it ends it for everyone and takes the
 * pointer out of the profile room. While live it shows on a viewer's Home; after, in the streamer's
 * profile Streams tab, where it can be renamed and deleted. (Recording needs Egress, which the e2e stack doesn't run.)
 */

const TOKEN_SERVER = process.env.E2E_TOKEN_SERVER ?? 'http://127.0.0.1:6168';
const enc = encodeURIComponent;

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      // Sharing picks the whole (fake) screen without asking.
      '--auto-select-desktop-capture-source=Entire screen',
    ],
  },
});

/**
 * The app's public API is served by the token server; in a deployment nginx routes it there. A
 * stream makes many requests, and Playwright's forwarding now and then reuses a connection the
 * token server has just closed as idle ("socket hang up"), which nginx never does: tried again.
 */
async function routePublicApi(page: Page): Promise<void> {
  await page.route('**/api/public/**', async (route) => {
    const url = new URL(route.request().url());
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await route.fetch({ url: `${TOKEN_SERVER}${url.pathname}${url.search}` });
        await route.fulfill({ response });
        return;
      } catch (err) {
        if (attempt >= 3 || !/socket hang up|ECONNRESET/.test(String(err))) throw err;
      }
    }
  });
}

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const page = await context.newPage();
  await routePublicApi(page);
  return page;
}

type Stream = { id: string; title?: string; state: string; viewers?: number; chatRoom: string | null };

async function streamsOf(user: TestUser): Promise<Stream[]> {
  const res = await fetch(`${TOKEN_SERVER}/api/public/streams?owner=${enc(user.localpart)}`);
  return ((await res.json()) as { streams: Stream[] }).streams;
}

async function readStream(id: string): Promise<Stream | undefined> {
  const res = await fetch(`${TOKEN_SERVER}/api/public/streams/${id}`);
  return res.ok ? ((await res.json()) as { stream: Stream }).stream : undefined;
}

async function livePointer(user: TestUser): Promise<Record<string, unknown>> {
  const { roomId } = await api<{ roomId: string }>(user, 'GET', `/user/${enc(user.userId)}/account_data/xyz.nekous.profile_room`);
  // Not written yet (or emptied) reads as no pointer.
  return api<Record<string, unknown>>(user, 'GET', `/rooms/${enc(roomId)}/state/xyz.nekous.live_stream/`).catch(() => ({}));
}

/** The watch page: the profile kept under it (hidden) has a player of its own. */
const watch = (page: Page) => role(page, 'stream-watch');

/** The player's video has frames: the stream really arrived. */
async function expectPicture(page: Page): Promise<void> {
  await expect
    .poll(() => role(watch(page), 'stream-video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 45_000 })
    .toBeGreaterThan(0);
}

test('going live from a profile, watched signed in with chat and signed out without, then ended for everyone', async ({ browser }) => {
  test.setTimeout(360_000);
  const [luna, bob] = await Promise.all([createUser('luna'), createUser('bob')]);

  // Luna goes live from her own profile.
  const lunaPage = await newPage(browser);
  await logIn(lunaPage, luna);
  await openOwnProfile(lunaPage);
  await role(lunaPage, 'go-live').click();
  await role(lunaPage, 'go-live-title').fill('Drawing a commission');
  await role(lunaPage, 'go-live-start').click();
  // Going live opens the dashboard; closed, it leaves the pill.
  await expect(role(lunaPage, 'dashboard')).toBeVisible({ timeout: 45_000 });
  await expect(role(lunaPage, 'dashboard-change-screen')).toBeVisible();
  await role(lunaPage, 'dashboard-close').click();
  await expect(role(lunaPage, 'live-bar')).toBeVisible();
  await expect(role(lunaPage, 'live-bar-viewers')).toContainText('0 watching');

  const [stream] = await eventually(() => streamsOf(luna), (list) => list[0]?.state === 'live');
  expect(stream.chatRoom).toMatch(/^!/);
  await eventually(() => livePointer(luna), (pointer) => pointer.stream_id === stream.id);
  // Her profile shows it above her posts, and the LIVE badge by her name.
  await expect(role(lunaPage, 'profile-stream')).toHaveAttribute('data-nu-state', 'live', { timeout: 45_000 });
  await expect(role(lunaPage, 'profile-live-badge')).toBeVisible();
  await lunaPage.screenshot({ path: test.info().outputPath('streamer-profile.png') });

  // Bob opens the watch page by its address, signed in: the player and the chat.
  const bobPage = await newPage(browser);
  await logIn(bobPage, bob);
  await bobPage.goto(`/@${luna.localpart}/live/${stream.id}`);
  await expect(role(bobPage, 'stream-watch')).toBeVisible({ timeout: 30_000 });
  await expect(role(watch(bobPage), 'stream-title')).toHaveText('Drawing a commission');
  await role(watch(bobPage), 'stream-play').click();
  await expectPicture(bobPage);
  await role(watch(bobPage), 'stream-chat-input').fill('hello from bob');
  await role(watch(bobPage), 'stream-chat-send').click();
  await expect(role(watch(bobPage), 'stream-chat-line').filter({ hasText: 'hello from bob' })).toBeVisible({ timeout: 15_000 });
  await bobPage.screenshot({ path: test.info().outputPath('watch-page.png') });

  // Audio only stops the picture, and back.
  await role(watch(bobPage), 'stream-audio-only').click();
  await expect(role(watch(bobPage), 'stream-video')).toBeHidden();
  await role(watch(bobPage), 'stream-audio-only').click();
  await expectPicture(bobPage);

  // Luna's own watch page (from her live bar) shows Bob's message.
  await role(lunaPage, 'live-bar').getByRole('button', { name: 'Drawing a commission' }).click();
  await expect(role(watch(lunaPage), 'stream-chat-line').filter({ hasText: 'hello from bob' })).toBeVisible({ timeout: 15_000 });

  // A visitor who isn't signed in: watches, reads the chat, and is offered sign-in instead of a box to write in.
  const visitor = await newPage(browser);
  await openApp(visitor, `/@${luna.localpart}/live/${stream.id}`);
  await expect(role(visitor, 'public-stream')).toBeVisible({ timeout: 30_000 });
  await role(watch(visitor), 'stream-play').click();
  await expectPicture(visitor);
  await expect(role(watch(visitor), 'stream-chat-line').filter({ hasText: 'hello from bob' })).toBeVisible({ timeout: 15_000 });
  await expect(role(watch(visitor), 'stream-chat-sign-in')).toBeVisible();
  await expect(role(watch(visitor), 'stream-chat-input')).toHaveCount(0);
  await visitor.screenshot({ path: test.info().outputPath('signed-out.png') });

  // Two watching (counted by the token server's sweep, every 15 s), and Luna's bar says so.
  await eventually(() => readStream(stream.id), (s) => (s?.viewers ?? 0) >= 2, 45_000);
  await expect(role(lunaPage, 'live-bar-viewers')).toContainText(/[2-9] watching/, { timeout: 30_000 });

  // A signed-in viewer's Home lists it under "Live now"; the card opens the watch page.
  const bobHome = await newPage(browser);
  await logIn(bobHome, bob);
  const card = role(bobHome, 'home-live-stream');
  await expect(card).toBeVisible({ timeout: 45_000 });
  await expect(card).toContainText('Drawing a commission');
  await expect(card).toContainText('LIVE');
  await card.click();
  await expect(role(bobHome, 'stream-title')).toHaveText('Drawing a commission', { timeout: 30_000 });
  await bobHome.close();

  // Luna ends it: everyone's connection goes, the server says it ended, and the pointer is empty.
  await role(lunaPage, 'live-bar-stop').click();
  await expect(role(lunaPage, 'live-bar')).toBeHidden({ timeout: 30_000 });
  expect((await readStream(stream.id))?.state).toBe('ended');
  await eventually(() => livePointer(luna), (pointer) => !pointer.stream_id);
  await expect(role(watch(bobPage), 'stream-player')).toContainText(/has ended|isn’t live|interrupted/, { timeout: 30_000 });
  // The chat is read-only now: Bob can't write in it any more.
  const chat = enc(stream.chatRoom!);
  await eventually(
    () => api<{ events_default?: number }>(bob, 'GET', `/rooms/${chat}/state/m.room.power_levels/`),
    (levels) => levels.events_default === 50
  );
  await expect(api(bob, 'PUT', `/rooms/${chat}/send/m.room.message/late-${Date.now()}`, { msgtype: 'm.text', body: 'too late' })).rejects.toThrow();

  // Her profile's Streams tab now lists it as a replay; she renames it, then deletes it for good.
  await role(lunaPage, 'stream-watch-back').click();
  await openOwnProfile(lunaPage);
  // The profile kept under the watch page is hidden: take the one showing.
  await lunaPage.locator('[data-nu-role="profile-tab-streams"]:visible').click();
  const tile = lunaPage.locator('[data-nu-role="stream-tile"]:visible');
  await expect(tile).toHaveCount(1);
  await expect(tile).toContainText('Drawing a commission');
  await expect(tile).toContainText('REPLAY');
  await role(tile, 'stream-tile-rename').click();
  const input = role(tile, 'stream-tile-rename-input');
  await input.fill('Finished piece');
  await input.press('Enter');
  await expect(tile).toContainText('Finished piece');
  expect((await readStream(stream.id))?.title).toBe('Finished piece');
  await role(tile, 'stream-tile-delete').click();
  await role(tile, 'stream-tile-delete-yes').click();
  await expect(tile).toHaveCount(0);
  expect(await readStream(stream.id)).toBeUndefined();
});

/** A fake of the streamer's side of the token server, for the flows that need no LiveKit (OBS isn't in the e2e stack). */
type Fake = { live: number; moderated: Record<string, unknown>[]; obsResets: number; stopped: boolean; mine: Record<string, unknown> | null };

async function fakeStreamApi(page: Page, chatRoom: string, owner: string, options: { obs?: 'off'; notReceiving?: number } = {}): Promise<Fake> {
  const fake: Fake = { live: 0, moderated: [], obsResets: 0, stopped: false, mine: null };
  const id = 'obsStream0000001';
  const record = (state: string) => ({
    id,
    owner,
    title: 'From OBS',
    state,
    liveAt: state === 'live' ? Date.now() - 5000 : null,
    endedAt: null,
    viewers: 4,
    chatRoom,
    thumbnail: null,
    replay: null,
    saving: false,
    expiresAt: null,
    source: 'obs',
  });
  const json = (route: import('@playwright/test').Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/public/streams**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    const body = (route.request().postDataJSON?.() ?? {}) as Record<string, unknown>;
    if (pathname === '/api/public/streams/obs') {
      if (options.obs === 'off') return json(route, { code: 'obs_off', error: 'off' }, 403);
      if (body.reset) fake.obsResets++;
      return json(route, { url: 'https://purr.example/api/public/whip', key: body.reset ? 'pk_newkey0123456789' : 'pk_oldkey0123456789' });
    }
    if (pathname === '/api/public/streams/mine') return json(route, { stream: fake.mine });
    if (pathname === '/api/public/streams' && method === 'POST') {
      fake.mine = record('starting');
      return json(route, { stream: record('starting'), token: 'preview', url: 'ws://127.0.0.1:1' }, 201);
    }
    if (pathname === `/api/public/streams/${id}/live`) {
      if (fake.live++ < (options.notReceiving ?? 2)) return json(route, { code: 'not_receiving', error: 'OBS is not sending yet' }, 409);
      fake.mine = record('live');
      return json(route, { stream: record('live') });
    }
    if (pathname === `/api/public/streams/${id}/preview`) return json(route, { token: 'preview', url: 'ws://127.0.0.1:1' });
    if (pathname === `/api/public/streams/${id}/moderate`) {
      fake.moderated.push(body);
      return json(route, { timeouts: body.action === 'timeout' ? { [String(body.user)]: Date.now() + Number(body.minutes) * 60_000 } : {} });
    }
    if (pathname === `/api/public/streams/${id}/stop`) {
      fake.stopped = true;
      fake.mine = null;
      return json(route, { stream: { ...record('ended'), endedAt: Date.now() } });
    }
    if (pathname === `/api/public/streams/${id}/thumbnail`) return route.fulfill({ status: 204 });
    if (pathname === `/api/public/streams/${id}`) return fake.mine?.state === 'live' ? json(route, { stream: record('live') }) : json(route, { code: 'not_found' }, 404);
    return route.fallback();
  });
  return fake;
}

async function chatRoomWith(luna: TestUser, bob: TestUser, text: string): Promise<{ roomId: string; eventId: string }> {
  const { room_id: roomId } = await api<{ room_id: string }>(luna, 'POST', '/createRoom', { name: 'live chat', preset: 'public_chat' });
  await api(bob, 'POST', `/join/${enc(roomId)}`, {});
  return { roomId, eventId: await sendText(bob, roomId, text) };
}

test('OBS: the setup page, waiting for OBS, going live, and moderating the chat from the dashboard', async ({ browser }) => {
  test.setTimeout(120_000);
  const [luna, bob] = await Promise.all([createUser('luna'), createUser('bob')]);
  const { roomId, eventId } = await chatRoomWith(luna, bob, 'be nice in here');

  const page = await newPage(browser);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const fake = await fakeStreamApi(page, roomId, luna.userId);
  await logIn(page, luna);
  await openOwnProfile(page);
  await role(page, 'go-live').click();

  // The setup page: OBS shows the address and the key (hidden until shown), and a new key after a confirm.
  await expect(role(page, 'go-live-page')).toBeVisible();
  await role(page, 'go-live-title').fill('From OBS');
  await role(page, 'go-live-source-obs').check();
  await expect(role(page, 'obs-url')).toHaveValue('https://purr.example/api/public/whip');
  await expect(role(page, 'obs-key')).toHaveAttribute('type', 'password');
  await role(page, 'obs-key-show').click();
  await expect(role(page, 'obs-key')).toHaveValue('pk_oldkey0123456789');
  await role(page, 'obs-reset').click();
  await role(page, 'obs-reset-yes').click();
  await expect(role(page, 'obs-key')).toHaveValue('pk_newkey0123456789');
  expect(fake.obsResets).toBe(1);
  await page.screenshot({ path: '/tmp/purrlor-setup.png' });

  // Go live: the dashboard waits for OBS (409 not_receiving twice, 3 s apart), then it's live.
  await role(page, 'go-live-start').click();
  await expect(role(page, 'dashboard')).toBeVisible();
  await expect(role(page, 'dashboard-waiting')).toContainText('Waiting for OBS… press Start Streaming in OBS');
  await expect(role(page, 'dashboard-state')).toHaveText('Waiting for OBS…');
  await expect(role(page, 'dashboard-state')).toBeHidden({ timeout: 30_000 });
  expect(fake.live).toBe(3);
  await expect(role(page, 'dashboard-viewers')).toHaveText('0');
  // Live: the profile pointer is written, and a browser-only control isn't there.
  await eventually(() => livePointer(luna), (pointer) => pointer.stream_id === 'obsStream0000001');
  await expect(role(page, 'dashboard-change-screen')).toHaveCount(0);

  // Moderation: each message from someone else has actions; the streamer's own would not.
  const line = role(page, 'stream-chat-line').filter({ hasText: 'be nice in here' });
  await expect(line).toBeVisible({ timeout: 20_000 });
  await line.hover();
  await role(line, 'mod-timeout').and(page.locator('[data-nu-minutes="5"]')).click();
  await expect(role(page, 'mod-untimeout')).toBeVisible();
  await role(page, 'mod-untimeout').click();
  await line.hover();
  await role(line, 'mod-ban').click();
  await line.hover();
  await role(line, 'mod-delete').click();
  await expect.poll(() => fake.moderated.length).toBe(4);
  expect(fake.moderated.map((m) => m.action)).toEqual(['timeout', 'untimeout', 'ban', 'delete']);
  expect(fake.moderated[0]).toMatchObject({ user: bob.userId, minutes: 5 });
  expect(fake.moderated[1]).toMatchObject({ user: bob.userId });
  expect(fake.moderated[3]).toMatchObject({ event_id: eventId });
  await page.screenshot({ path: '/tmp/purrlor-dashboard.png' });

  // The pill remains when the dashboard is closed; ending takes it all down and empties the pointer.
  await role(page, 'dashboard-close').click();
  await expect(role(page, 'live-bar-viewers')).toContainText('watching');
  await role(page, 'live-bar-dashboard').click();
  await role(page, 'dashboard-stop').click();
  await expect(role(page, 'dashboard')).toBeHidden();
  expect(fake.stopped).toBe(true);
  await eventually(() => livePointer(luna), (pointer) => !pointer.stream_id);
});

test('OBS: hidden when the server has none, and picked up again after a reload', async ({ browser }) => {
  test.setTimeout(90_000);
  const luna = await createUser('luna');
  const page = await newPage(browser);
  const off = await fakeStreamApi(page, '!none:purr.example', luna.userId, { obs: 'off' });
  await logIn(page, luna);
  await openOwnProfile(page);
  await role(page, 'go-live').click();
  await expect(role(page, 'go-live-obs-off')).toContainText('Streaming from OBS isn’t set up on this server');
  await expect(role(page, 'go-live-source-obs')).toHaveCount(0);
  expect(off.moderated).toHaveLength(0);

  // The server still has an OBS stream of hers, live: the reload brings its dashboard back.
  const page2 = await newPage(browser);
  const fake = await fakeStreamApi(page2, '!none:purr.example', luna.userId);
  fake.mine = { id: 'obsStream0000001', owner: luna.userId, title: 'From OBS', state: 'live', liveAt: Date.now() - 60_000, endedAt: null, viewers: 4, chatRoom: null, thumbnail: null, replay: null, expiresAt: null, source: 'obs' };
  await logIn(page2, luna);
  await expect(role(page2, 'dashboard')).toBeVisible({ timeout: 30_000 });
  await expect(role(page2, 'dashboard-title')).toHaveValue('From OBS');
  await expect(role(page2, 'dashboard-stop')).toBeVisible();

  // A browser stream can't be picked up: only ended.
  const page3 = await newPage(browser);
  const other = await fakeStreamApi(page3, '!none:purr.example', luna.userId);
  other.mine = { ...fake.mine, source: 'browser' };
  await logIn(page3, luna);
  await expect(role(page3, 'dashboard-orphan')).toBeVisible({ timeout: 30_000 });
  await role(page3, 'dashboard-stop').click();
  await expect(role(page3, 'dashboard')).toBeHidden();
  expect(other.stopped).toBe(true);
});
