# Purrlor for Android

An Android app for **Purrlor**: the web client in the app's own window (a WebView), with the three
things a browser tab can't do: **notifications that arrive with the app closed** (UnifiedPush),
**tapping one opens the app at the right room**, and **a voice call that keeps going in the
background** (a foreground service). The page is still the website, so every deploy of the web
client reaches the app at once. The contract between the page and the app is in
[`docs/android.md`](../../docs/android.md).

## Choosing a server

As in the Windows app, the first launch asks **which Purrlor server**: the address you'd open
Purrlor at in a browser, `purr.meowops.net` (filled in) or your own deployment's `app.example.com`.
The app checks it's a Purrlor site (it has the web client's `/config.json`) before opening it.
Long-press the app's icon for **Change server**. The WebView keeps each server's sign-in apart, so
switching back picks up where you left off.

The server decides the rest, as in a browser: one locked to its own homeserver
(`PURRLOR_HOMESERVER_URL`) signs you in there, and an unlocked one asks for a homeserver on its
login screen.

## What works

- Sign-in, encryption keys and settings, kept by the app's WebView
- **Notifications** through a UnifiedPush app on the phone ([ntfy](https://ntfy.sh) and others),
  with no Google services. Install one, then turn notifications on in Purrlor's settings. A tap
  opens the room. On Android 13 and later the app asks for permission to show them
- **Calls** keep running with the screen off or another app in front; an ongoing notification
  brings you back
- Voice and video calls with the microphone and camera asked for as needed
- Sharing text and links to Purrlor from other apps
- Links to `https://purr.meowops.net/...` open in the app (links to other servers open in the browser)

Not yet: sharing pictures and videos from other apps (the Trusted Web Activity version had it
through the site's service worker), and Play Store push (UnifiedPush only, by design).

## App links

A link to a server's site opens in the app (rather than the browser) once that site vouches for
it: Android fetches `https://<server>/.well-known/assetlinks.json` and checks it names this app
and the key it's signed with. Without it the app still works; links just open in the browser. Each
server does this for itself, with this app's package name and fingerprints.

The web container writes that file from two settings in the deployment's `.env`
(`apps/web/deploy/40-purrlor-config.sh`), then `purrlor restart web` (or recreate the container):

| Setting | What |
| --- | --- |
| `PURRLOR_ANDROID_PACKAGE` | The app's package name: `net.meowops.purrlor` |
| `PURRLOR_ANDROID_CERT_SHA256` | SHA-256 fingerprints of the keys the app is signed with, comma-separated: `AB:CD:…` |

Which fingerprints:

- **Your upload key**, the one the release build is signed with (below):
  `keytool -list -v -keystore upload.jks -alias upload` prints it under "SHA256".
- **Google Play's app signing key**, if the app goes on Play: Play re-signs what you upload, so
  phones see Play's key. It's in Play Console → your app → Test and release → App integrity →
  App signing. List both.
- To try a **debug build** full screen, its key too: `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android`.

Check it with `curl https://purr.meowops.net/.well-known/assetlinks.json`, or Google's
[Statement List tester](https://developers.google.com/digital-asset-links/tools/generator).

## Building

The [Android workflow](../../.github/workflows/android.yml) builds a debug APK on every change to
`apps/android` (download it from the run's artifacts). A tag `android-vX.Y.Z` matching
`versionName` in `app/build.gradle` builds the signed release APK and the Play bundle (AAB) and
publishes them as a GitHub release.

Release signing uses four repository secrets:

| Secret | What |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The upload keystore, base64: `base64 -w0 upload.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | Its password |
| `ANDROID_KEY_ALIAS` | The key's alias (`upload` below) |
| `ANDROID_KEY_PASSWORD` | The key's password |

Make the upload key once, and keep it (and a copy) somewhere safe: an app on Play can only be
updated with it, or by asking Google to reset it.

```sh
keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
```

Bump `versionCode` (by one) and `versionName` in `app/build.gradle` for each release.

### On your own computer

With [Android Studio](https://developer.android.com/studio) (or a JDK 17, the Android SDK and
Gradle 8.11): open `apps/android`, or run `gradle assembleDebug` there. The APK is in
`app/build/outputs/apk/debug/`. The Gradle wrapper isn't checked in; `gradle wrapper` makes one if
you want it. To sign a release locally, set `PURRLOR_KEYSTORE` (the path to `upload.jks`),
`PURRLOR_KEYSTORE_PASSWORD`, `PURRLOR_KEY_ALIAS` and `PURRLOR_KEY_PASSWORD`, then
`gradle assembleRelease bundleRelease`.

## Your own build

This app works with any Purrlor server, so most deployments don't need a build of their own; they
set the two assetlinks settings above with this app's package name and fingerprints. To publish
your own (your name, your server suggested and handling its links), set these in
`gradle.properties` (or pass `-Ppurrlor.host=app.example.com` and so on to `gradle`), and use the
same package name in your server's `PURRLOR_ANDROID_PACKAGE`:

| Property | Default |
| --- | --- |
| `purrlor.host` | `purr.meowops.net`: filled in on first launch, and whose links open in the app |
| `purrlor.applicationId` | `net.meowops.purrlor`; yours must differ to be on Play, and is permanent once it is |
| `purrlor.appName` | `Purrlor` |
