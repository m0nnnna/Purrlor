# The Android app and the web client

`apps/android` runs the web client in a WebView and gives it `window.PurrlorNative`
(`apps/web/src/matrix/nativeApp.ts`). Everywhere else that object doesn't exist and every call is
a no-op, so the web client stays one code base.

## Notifications: UnifiedPush

A WebView has no Web Push, so the app uses [UnifiedPush](https://unifiedpush.org): a distributor
app on the phone (ntfy and others) gives Purrlor an **endpoint**, a URL that wakes the app when
posted to. No Google services and no Firebase secrets.

1. The page calls `PurrlorNative.enablePush()`. The app asks for the notification permission
   (Android 13+), picks the phone's distributor and registers; the endpoint arrives later in
   `PushReceiver.onNewEndpoint` and the app fires a `purrlor-native-push` event on `window`.
2. The page reads `PurrlorNative.pushState()` (`{endpoint, distributors, allowed}`) and sends
   `POST /subscribe {openid_token, pushkey, unifiedpush: {endpoint}}` to the push gateway, then
   registers a Matrix pusher with `app_id` `xyz.nekous.unifiedpush` and the same `pushkey`
   (`apps/web/src/matrix/push.ts`).
3. The homeserver calls the gateway's `/_matrix/push/v1/notify` as for any pusher. For a pushkey
   with a UnifiedPush endpoint, the gateway POSTs the same JSON it would Web Push
   (`{title, body, roomId, eventId, unreadCount}`; reminders add `tag`) to the endpoint.
   404/410 from the distributor drops the endpoint and reports the pushkey `rejected`.
4. `PushReceiver.onMessage` shows the notification. Tapping it opens `PurrlorActivity` with the
   room id: a cold start loads `/?openRoom=<roomId>`; a running page gets a `purrlor-open-room`
   event (`useOpenRoomFromNotification`).

The gateway keeps `pushkey -> {owner, endpoint}` in `UNIFIEDPUSH_FILE`
(`services/push-gateway/src/unifiedpush.ts`). A pushkey belongs to the account that registered it,
across Web Push and UnifiedPush alike. The endpoint is a URL a client chose and the gateway then
calls, so it must be **https, without credentials, and not a local or private address**; names are
checked again at send time (no DNS tricks) and redirects aren't followed.

## Calls in the background

While a voice call is on the page, `VoiceCallSession` calls `PurrlorNative.callActive(true)` and
the app starts `CallService`, a foreground service (microphone, plus camera when granted) with an
ongoing notification, so Android keeps the app and its audio alive when it leaves the screen.
`callActive(false)` stops it.

## Bridge reference

| Page → app | |
| --- | --- |
| `pushState()` | JSON `{endpoint, distributors, allowed}` |
| `enablePush()` / `disablePush()` | register / unregister with the distributor |
| `testNotification()` | shows a local notification |
| `callActive(bool)` | start / stop the call service |

| App → page (events on `window`) | |
| --- | --- |
| `purrlor-native-push` | push state changed; reread `pushState()` |
| `purrlor-open-room` | `detail.roomId` — a notification was tapped |
