# Purrlor Desktop

A Windows desktop app for **Purrlor**. It hosts a Purrlor web client deployment in Microsoft Edge
WebView2, so it has everything the browser client has (messaging, voice and video, screen share,
encryption, notifications) plus a tray icon and Start with Windows.

## Choosing a server
On first launch the app asks **which Purrlor server** to connect to: the address you'd open
Purrlor at in a browser, e.g. `purr.meowops.net` (the default) or your own deployment's
`app.example.com`. The server name in the title bar (or **Change server…** in the tray menu)
switches it later.

That address is the Purrlor web client, not the Matrix homeserver. The server decides the rest:
a deployment locked to one homeserver (`PURRLOR_HOMESERVER_URL`) signs you in there, and an
unlocked one shows the usual homeserver field on its login screen, so the desktop app works
with any Matrix homeserver that deployment can reach. Voice, invite links, and CORS work the same
as they do in the browser, because the page is loaded from the server itself.

Each server keeps its own sign-in and encryption keys, so switching back picks up where you
left off.

## Features
- WebView2 with the Purrlor server's camera, microphone, notification, clipboard and autoplay
  permissions granted up front (nothing is granted to any other site)
- Borderless dark title bar, Windows Snap and edge/corner resizing, multi-monitor window state
- Windows notifications (in the Action Center, following Focus Assist and Do Not Disturb); clicking
  one opens the room
- A badge on the taskbar button (and a dot on the tray icon) counting unread DMs and mentions
- Shows you as Away after 10 minutes without keyboard or mouse, or when the PC locks, and Online
  again when you're back (only if you were Online; never during a call)
- The keyboard's media keys and Windows' media flyout control Purrlor's music player while it's
  the one playing
- Keeps itself up to date (see "Updates" below)
- Close-to-tray, so notifications keep arriving (Settings → Desktop can make
  the close button quit instead)
- Start with Windows (starts in the tray)
- Voice keybinds (push-to-talk, mute, deafen; set in Settings → Voice & Audio) that work while
  another window is in front, a game included. See "Keybinds and privacy" below.
- Links to other sites open in the default browser
- Downloads go to the Windows Downloads folder
- Only one copy runs; launching it again brings the window back
- Self-contained x64 build with a per-user NSIS installer (no admin rights). It installs the
  WebView2 Runtime if the machine doesn't have it

Settings and browser data live in `%LOCALAPPDATA%\Purrlor`, and the app itself in
`%LOCALAPPDATA%\Programs\Purrlor`. Uninstalling removes the app but keeps the data.

## Settings
Purrlor's own Settings gets a **Desktop** tab inside the app: Start with Windows, what the close
button does, and the server. The app keeps these in its `settings.json`, not in the page's storage.
Voice & Audio (microphone, speakers, voice processing) is in the web client and works the same in a
browser.

## The bridge
The page and the app talk over WebView2's message channel (`window.chrome.webview` in the page,
`WebMessageReceived` / `PostWebMessageAsJson` here; the page's side is
`apps/web/src/desktop/desktopBridge.ts`). The app answers only messages from the configured
server's own page and ignores anything else. Every message is JSON tagged `"purrlor": 1`:

| Page asks (`method`) | Takes (`params`) | Answers (`result`) |
|---|---|---|
| `getInfo` | | `{ version, settings: { startWithWindows, closeToTray } }` |
| `setSetting` | `{ name, value }` (`startWithWindows` or `closeToTray`, true/false) | the settings |
| `setHotkeys` | `{ bindings: [{ id, code, ctrl, alt, shift }] }` (`code` is a `KeyboardEvent.code`, or `Mouse4`/`Mouse5`; `[]` stops watching) | `{ unknown: [ids whose key it doesn't know] }` |
| `setBadge` | `{ count }` | nothing |
| `watchIdle` | `{ minutes }` (0 stops) | nothing; `idle` events follow |
| `checkForUpdates` | | the update state (below); `update` events follow |
| `installUpdate` | | nothing; the app restarts into the new version |
| `changeServer` | | nothing; the app opens its server dialog |

A request is `{ purrlor: 1, id, method, params }` and its answer `{ purrlor: 1, id, result }` or
`{ purrlor: 1, id, error }`. The app also sends events unasked, `{ purrlor: 1, event, data }`:
`settings` when the tray menu changes one, `hotkey` (`{ id, down }`) when a bound key goes down or
up, `update` (`{ state, version, error, releaseUrl, automatic }`, also in `getInfo`) as an update is
checked for, downloaded and ready, and `idle` (`{ idle }`) when you leave the computer or come back. Windows' idle timer only says
when the last input was, never what it was. Desktop 1.0.0 has no bridge, so the page treats
silence as "update the app".

## Keybinds and privacy
The keybinds work outside Purrlor because the app installs Windows' low-level keyboard hook
(`GlobalHotkeys.cs`), plus the mouse hook when a side button is bound. That hook sees every key
pressed anywhere, so the app keeps its use narrow:

- It's installed only while the page has keys bound, which it does when you join a call, and it's
  removed when you leave, sign out or the page reloads. Outside a call Purrlor watches nothing.
- Each press is compared with the bound keys and forgotten. Only a bound key going down or up is
  reported to the page, as `pushToTalk`, `mute` or `deafen`; no other key is stored, logged or sent.
- Keys are never swallowed: the game still gets them.

Windows doesn't pass a hook the input of a program running as administrator unless the hook's
program is too, so keybinds don't fire while such a game is in front.

## Updates
From 1.2.0 the app keeps itself up to date (`Updater.cs`). Two minutes after it starts, and every
six hours, it reads this repository's releases for a newer `desktop-vX.Y.Z`, downloads its
installer into `%LOCALAPPDATA%\Purrlor\Updates`, and offers "Restart to update" in the tray menu and
Settings → Desktop. Quitting Purrlor installs it too, silently (the installer's `/S`, with
`/RELAUNCH` to start the new version after). An update found at sign-in, with Purrlor starting in
the tray, installs straight away. Settings → Desktop can switch the automatic checks off.

There's no code-signing certificate, so the app checks updates against a key of its own: the
release workflow signs each installer (`Purrlor-Setup.exe.sig`, ECDSA P-256 over
`purrlor-desktop-update\n<version>\n<sha256 of the installer>\n`) with the
`DESKTOP_UPDATE_SIGNING_KEY` Actions secret, and the app holds the public half (`UpdatePublicKey` in
`Purrlor.csproj`). An installer that doesn't verify is deleted and never run, and since the version
is signed, an old installer can't be passed off as a new one.

The private key exists only in that secret. If it's ever lost or leaked, make a new pair, put the
new public key in `Purrlor.csproj` and the private one in the secret: installed apps can't verify
anything signed with the new key, so that one release has to be installed by hand. To make a pair
(PowerShell 7):

```
$k = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
[Convert]::ToBase64String($k.ExportSubjectPublicKeyInfo())   # UpdatePublicKey
$k.ExportPkcs8PrivateKeyPem() | gh secret set DESKTOP_UPDATE_SIGNING_KEY
```

A fork sets `UpdateRepository` to its own repository and makes its own pair; with `UpdatePublicKey`
empty, its app only says when a new version is out, with a link.

## Build
Purrlor runs on Windows 10 1809 or later (the Windows notifications need it).

Needs the .NET 8 SDK and [NSIS](https://nsis.sourceforge.io). Run `Build-Purrlor.bat` (or
`Build-Purrlor.ps1`); the installer lands at `dist\Purrlor-Setup.exe`.

## Release
Bump `<Version>` in `Purrlor/Purrlor.csproj`, then push a matching tag:

```
git tag desktop-v1.0.0
git push origin desktop-v1.0.0
```

The `Desktop` workflow builds the installer and publishes it as a GitHub release.
