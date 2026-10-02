import { expect, test, type Locator, type Page } from '@playwright/test';
import { logIn, role } from './app';
import { createUser } from './matrix';

/**
 * A creator sorting their music into albums in the page builder: uploads into an album, a second
 * album with a cover, a track moved between them, then the published page's shelf and player.
 */

/** A second of silence as a WAV file: a real sound the browser can measure and play. */
function silentWav(seconds = 1): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const wav = Buffer.alloc(44 + samples);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples, 40);
  wav.fill(128, 44);
  return wav;
}

// Long enough to still be playing when the test looks back at the shelf.
const track = (name: string) => ({ name, mimeType: 'audio/wav', buffer: silentWav(30) });

async function addTracks(album: Locator, names: string[]): Promise<void> {
  const before = await role(album, 'page-editor-track').count();
  await role(album, 'page-editor-add-tracks').setInputFiles(names.map(track));
  await expect(role(album, 'page-editor-track')).toHaveCount(before + names.length, { timeout: 30_000 });
}

async function openBuilder(page: Page): Promise<void> {
  await role(page, 'server-rail-global-feed').click();
  await role(page, 'social-nav-profile').click();
  await role(page, 'profile-edit-page').click();
  await expect(role(page, 'page-editor')).toBeVisible();
}

test('a creator sorts tracks into albums, and visitors browse and play them', async ({ page }, testInfo) => {
  const artist = await createUser('artist');
  await logIn(page, artist);
  await openBuilder(page);

  await role(page, 'page-editor-add-block').selectOption('music');
  const albums = role(page, 'page-editor-music-album');
  await expect(albums).toHaveCount(1);

  await role(albums.nth(0), 'page-editor-music-album-title').fill('Night Drive');
  await addTracks(albums.nth(0), ['Headlights.wav', 'Overpass.wav', 'Stray demo.wav']);

  await role(page, 'page-editor-add-music-album').click();
  await expect(albums).toHaveCount(2);
  await role(albums.nth(1), 'page-editor-music-album-title').fill('Demos');
  await albums.nth(1).getByLabel('Year (optional)').fill('2025');
  // Any real PNG will do for a cover: a square of the screen.
  const cover = await page.screenshot({ clip: { x: 0, y: 0, width: 64, height: 64 } });
  await albums.nth(1).locator('input[type="file"]:not([accept*="audio"])').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: cover });
  await expect(albums.nth(1).locator('.nu-page-editor__thumb img')).toBeVisible({ timeout: 30_000 });

  // The demo belongs in Demos.
  const stray = role(albums.nth(0), 'page-editor-track').nth(2);
  await role(stray, 'page-editor-track-album').selectOption({ label: 'Demos' });
  await expect(role(albums.nth(0), 'page-editor-track')).toHaveCount(2);
  await expect(role(albums.nth(1), 'page-editor-track')).toHaveCount(1);
  await expect(role(albums.nth(1), 'page-editor-track').locator('input').first()).toHaveValue('Stray demo');
  await page.screenshot({ path: testInfo.outputPath('builder.png'), fullPage: true });

  await role(page, 'page-editor-publish').click();
  await expect(role(page, 'page-editor')).toBeHidden({ timeout: 30_000 });

  // The published page: a shelf of the two albums.
  const cards = role(page, 'music-album-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Night Drive');
  await expect(cards.nth(0)).toContainText('2 tracks');
  await expect(cards.nth(1)).toContainText('Demos');
  await expect(cards.nth(1)).toContainText('2025 · 1 track');
  await expect(cards.nth(1).locator('img')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('shelf.png'), fullPage: true });

  await cards.nth(0).click();
  await expect(role(page, 'music-track')).toHaveCount(2);
  await role(page, 'music-play-album').click();
  const audio = page.locator('[data-nu-role="music-player"] audio');
  await expect(audio).toHaveAttribute('src', /.+/);
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('album.png'), fullPage: true });

  await role(page, 'music-albums-back').click();
  await expect(cards.nth(0)).toContainText('Playing');
});
