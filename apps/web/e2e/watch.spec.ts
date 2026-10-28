import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { logIn, openApp, openOwnProfile, role } from './app';
import { api, createUser, uniqueName } from './matrix';

/**
 * WATCH (docs/watch.md) through the real token server: someone uploads a video from their profile's
 * Videos tab, it shows in the WATCH page's Latest grid for a follower and opens on its own page with a
 * player that plays and seeks, a link to it opens for a signed-out visitor, and the owner edits and
 * deletes it. Needs ffmpeg on the test machine (it makes the two-second clip).
 */

const TOKEN_SERVER = process.env.E2E_TOKEN_SERVER ?? 'http://127.0.0.1:6168';

/** The app's public API is served by the token server; in a deployment nginx routes it there. */
async function routePublicApi(page: Page): Promise<void> {
  await page.route('**/api/public/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${TOKEN_SERVER}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
}

async function newPage(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await routePublicApi(page);
  return page;
}

/** A two-second test clip, as a WebM the browser can decode. */
function makeClip(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'watch-e2e-')), 'clip.webm');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '2', '-c:v', 'libvpx', '-b:v', '200k', path]);
  return path;
}

test('uploading a video, watching it from the WATCH page, signed out by its link, then editing and deleting it', async ({ browser }) => {
  test.setTimeout(420_000);
  const [luna, bob] = await Promise.all([createUser('luna'), createUser('bob')]);
  const clip = makeClip();
  // Unique, as earlier runs' videos stay in the catalogue.
  const tag = uniqueName('clip');
  const title = `My first video ${tag}`;
  expect(readFileSync(clip).length).toBeGreaterThan(0);

  // Luna uploads from her Videos tab.
  const lunaPage = await newPage(browser);
  await logIn(lunaPage, luna);
  await openOwnProfile(lunaPage);
  await lunaPage.locator('[data-nu-role="profile-tab-videos"]:visible').click();
  await role(lunaPage, 'video-upload-open').click();
  await role(lunaPage, 'video-upload-file').setInputFiles(clip);
  await expect(role(lunaPage, 'video-upload-title')).not.toHaveValue('', { timeout: 30_000 });
  await role(lunaPage, 'video-upload-title').fill(title);
  await role(lunaPage, 'video-upload-description').fill('Made for the test, see https://example.com/x');
  await role(lunaPage, 'video-upload-submit').click();
  const card = lunaPage.locator('[data-nu-role="video-card"]:visible').filter({ hasText: title });
  await expect(card).toBeVisible({ timeout: 60_000 });

  // Bob finds it under WATCH (search narrows the grid; the catalogue lags up to two minutes) and opens it.
  const bobPage = await newPage(browser);
  await logIn(bobPage, bob);
  await role(bobPage, 'server-rail-watch').click();
  await expect(role(bobPage, 'watch-view')).toBeVisible();
  await role(bobPage, 'watch-search').fill(tag);
  const bobCard = role(bobPage, 'watch-grid').locator('[data-nu-role="video-card"]').filter({ hasText: title });
  await expect(bobCard).toBeVisible({ timeout: 150_000 });
  await role(bobCard, 'video-card-open').first().click();
  await expect(role(bobPage, 'video-title')).toHaveText(title);
  await expect(role(bobPage, 'video-description')).toContainText('https://example.com/x');
  await role(bobPage, 'video-play').click();
  const video = role(bobPage, 'video-element');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 }).toBeGreaterThan(0);
  // The player's address is the play route's, never the mxc.
  expect(await video.getAttribute('src')).toMatch(/\/api\/public\/watch\/file\//);
  await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 1;
  });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.5);

  // A visitor who isn't signed in opens its link, once Luna's public web is on and picked up.
  const videoId = await role(bobPage, 'video-page').getAttribute('data-nu-video');
  expect(videoId).toMatch(/^[A-Za-z0-9_-]{16}$/);
  const { roomId: profileRoomId } = await api<{ roomId: string }>(luna, 'GET', `/user/${encodeURIComponent(luna.userId)}/account_data/xyz.nekous.profile_room`);
  await api(luna, 'PUT', `/rooms/${encodeURIComponent(profileRoomId)}/state/xyz.nekous.public_web/`, { enabled: true });
  await expect
    .poll(async () => (await fetch(`${TOKEN_SERVER}/api/public/watch/${luna.localpart}/${videoId}`)).status, { timeout: 150_000, intervals: [3000] })
    .toBe(200);
  const visitor = await newPage(browser);
  await openApp(visitor, `/@${luna.localpart}/video/${videoId}`);
  await expect(role(visitor, 'public-video')).toBeVisible({ timeout: 30_000 });
  await expect(role(visitor, 'video-title')).toHaveText(title);
  await expect(role(visitor, 'video-comments-signin')).toBeVisible();

  // Luna renames it, then deletes it.
  await role(card, 'video-edit-open').click();
  await role(lunaPage, 'video-edit-title').fill('Renamed video');
  await role(lunaPage, 'video-edit-save').click();
  await expect(lunaPage.locator('[data-nu-role="video-card"]:visible').filter({ hasText: 'Renamed video' })).toBeVisible({ timeout: 30_000 });
  await role(lunaPage.locator('[data-nu-role="video-card"]:visible').filter({ hasText: 'Renamed video' }), 'video-edit-open').click();
  await role(lunaPage, 'video-delete').click();
  await role(lunaPage, 'video-delete-yes').click();
  await expect(lunaPage.locator('[data-nu-role="video-card"]:visible')).toHaveCount(0, { timeout: 30_000 });
});
