# Your data: downloading it, and deleting your account

Account Settings → Your data. Both run in the person's own browser, as them; nothing here needs the
server's admin. The code is `apps/web/src/matrix/dataExport.ts`, `deleteAccount.ts` and
`ownEvents.ts`, and `apps/web/src/app/YourDataSettings.tsx`. `e2e/your-data.spec.ts` checks both
against a real homeserver.

## Download my data

A ZIP file put together in the browser, from the homeserver's full history (not just what the
app has loaded). The browser is the only place an encrypted conversation can be read, so that's
where it's built.

| In the ZIP | What it holds |
| --- | --- |
| `README.txt` | What's in the ZIP, in words |
| `account.json` | User ID, profile, extended profile, sessions, and account data (settings, saved and private things) without the encrypted key material (`m.secret_storage.*`, `m.cross_signing.*`, `m.megolm_backup.*`) |
| `profile-page.json` | The published profile page and any unpublished draft |
| `posts/` | Global posts (`Global.json`) and posts in each Space, one file each |
| `private-posts.json` | "Only me" posts |
| `messages/` | Every message the person sent, one file per channel or conversation, oldest first; an edit is listed with the message it changes |
| `comments.json` | Their comments on posts, their own and other people's |
| `media/` | The files they uploaded, decrypted (optional); any that couldn't be fetched are listed in `could-not-download.txt` |
| `theme.css` | Their custom theme, if any |

Only what the person sent goes in: other people's messages are theirs. Encryption keys are left
out. The messages are already decrypted in the ZIP, and another Matrix app reads the encrypted
history with the recovery key. A message the session has no key for is marked `undecryptable`.

Reading a room asks `/messages` filtered to the person's own events (`senders`), so a big room
with few messages from them is quick. Files are stored, not compressed (`zip.ts`, no dependency).

## Delete my account

Matrix calls it deactivating. Checked against Continuwuity:

- The account can't sign in again (`M_USER_DEACTIVATED`), its sessions end, and its name can't be
  registered by anyone else.
- It leaves every room, and its display name and avatar are cleared.
- **Messages stay.** Continuwuity accepts `erase: true` and ignores it: what was sent stays
  readable by the people in those rooms. The dialog says so.

So Purrlor's own things are tidied up first, in this order, while the account still can:

1. **The password is checked** by signing in with it (a session that's signed out again at once).
   Nothing is changed before that passes.
2. **The public page is switched off.**
3. **Posts and the profile page** (unless the person unticks it): every post in the profile room
   and in each Space's feed is deleted (redacted, waiting out rate limits), and the page is
   unpublished. Comments and messages aren't touched.
4. **Notifications and reminders** are stopped at the push gateway, which doesn't otherwise learn
   that the account is gone.
5. **The account is deactivated** with `erase: true`, confirmed with the same password.

If a step fails, the ones after it don't run and the account isn't deleted. The dialog warns about
any Space the person is the only admin of (`spacesOnlyYouRun`), since nobody could run it after.

**Whatever the cleanup misses**, someone who has left their own profile room isn't shown: not on the
public web (the token server's `ownerStillThere`), and not in the app's Global feed
(`profileSourceFromState`). Space feeds already left out anyone who isn't a member of the Space.

An admin can still close an account from the server with `purrlor user deactivate <name>`, which
skips the cleanup (the public web and Global feed stop showing that person all the same).
