import { expect, test } from '@playwright/test';
import { logIn, role, windowsSettled } from './app';
import { api, createSpaceWithChannel, createUser, eventually, latestEvents, uniqueName } from './matrix';

/**
 * Tagging someone in a picture (matrix/imageTags.ts): placed in the composer, sent on the picture
 * with its spot, mentioning the person (a Global post invites them, worded as a tag), and shown on
 * the posted picture.
 */

const enc = encodeURIComponent;

test('a person tagged in a Global post’s picture is told, and their name shows on it', async ({ page }) => {
  test.setTimeout(120_000);
  const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  await api(bob, 'PUT', `/profile/${enc(bob.userId)}/displayname`, { displayname: 'Bobby Tables' });
  // Somewhere they share, so Alice's app knows Bob to offer him.
  await createSpaceWithChannel(alice, [bob]);

  await logIn(page, alice);
  await role(page, 'server-rail-global-feed').click();
  const text = uniqueName('beach day');
  await role(page, 'feed-composer-input').fill(text);
  // A real picture, drawn by the browser: 200 by 120.
  const png = Buffer.from(
    (
      await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 200;
        canvas.height = 120;
        const g = canvas.getContext('2d')!;
        g.fillStyle = '#f80';
        g.fillRect(0, 0, 200, 120);
        g.fillStyle = '#08f';
        g.fillRect(50, 40, 40, 40);
        return canvas.toDataURL('image/png');
      })
    ).split(',')[1],
    'base64'
  );
  await page.locator('[data-nu-role="feed-composer"] input[type="file"]').setInputFiles({ name: 'beach.png', mimeType: 'image/png', buffer: png });
  await role(page, 'composer-preview-tag').click();

  // Tap a spot a third of the way across and halfway down, and pick Bob.
  const picture = role(page, 'image-tagger-image');
  await windowsSettled(page);
  const box = (await picture.boundingBox())!;
  await page.mouse.click(box.x + box.width / 3, box.y + box.height / 2);
  await role(page, 'image-tagger-search').fill('Bobby');
  await role(page, 'image-tagger-person').filter({ hasText: 'Bobby Tables' }).click();
  await expect(page.locator('.nu-image-tags__label--editing')).toContainText('Bobby Tables');
  await role(page, 'image-tagger-done').click();
  await expect(role(page, 'composer-preview-tag')).toContainText('1');
  await role(page, 'feed-composer-submit').click();
  const card = role(page, 'global-feed-post').filter({ hasText: text });
  await expect(card).toBeVisible();

  // On the server: the picture carries the tag where it was put, and the post mentions Bob.
  const { roomId } = await api<{ roomId: string }>(alice, 'GET', `/user/${enc(alice.userId)}/account_data/xyz.nekous.profile_room`);
  const events = await eventually(
    () => latestEvents(alice, roomId),
    (evs) => evs.some((e) => e.type === 'xyz.nekous.post' && e.content.body === text)
  );
  const post = events.find((e) => e.type === 'xyz.nekous.post' && e.content.body === text)!;
  const [tag] = post.content['xyz.nekous.attachments'][0].tags;
  expect(tag.user_id).toBe(bob.userId);
  // In whole ten-thousandths of the picture: a third across, halfway down.
  expect(Number.isInteger(tag.x) && Number.isInteger(tag.y)).toBe(true);
  expect(Math.abs(tag.x - 3333)).toBeLessThan(300);
  expect(Math.abs(tag.y - 5000)).toBeLessThan(300);
  expect(post.content['m.mentions'].user_ids).toContain(bob.userId);

  // Bob isn't in Alice's profile room, so he's invited, told it's a tag.
  const invite = await eventually(
    () => latestEvents(alice, roomId),
    (evs) => evs.some((e) => e.type === 'm.room.member' && (e as unknown as { state_key: string }).state_key === bob.userId)
  );
  const member = invite.find((e) => e.type === 'm.room.member' && (e as unknown as { state_key: string }).state_key === bob.userId)!;
  expect(member.content.membership).toBe('invite');
  expect(member.content.reason).toMatch(/^Tagged you in a photo \(xyz\.nekous\.mention \$/);

  // On the posted picture: the tags button, and Bob's name at his spot once it's pressed.
  await expect(role(card, 'post-media-tags-toggle')).toHaveAccessibleName(/1 person tagged/);
  await role(card, 'post-media-tags-toggle').click();
  await expect(role(card, 'post-media-tag')).toHaveText('Bobby Tables');
  await role(card, 'post-media-tag').click();
  // Tapping the name opens Bob's profile.
  await expect(page.getByText(`@${bob.localpart}`, { exact: true })).toBeVisible();
});
