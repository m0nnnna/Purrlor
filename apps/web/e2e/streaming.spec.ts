import { expect, test, type Browser, type Page } from '@playwright/test';
import { logIn, openApp, openOwnProfile, role } from './app';
import { api, createUser, eventually, type TestUser } from './matrix';

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
  await expect(role(lunaPage, 'live-bar')).toBeVisible({ timeout: 45_000 });
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
