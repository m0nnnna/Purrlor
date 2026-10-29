# Purrlor Desktop

The desktop app for **Purrlor**, on Windows and Linux. It opens a Purrlor web client deployment in
Electron (Chromium), so it has everything the browser client has (messaging, voice and video, screen
share, encryption, notifications), plus a tray icon, start on sign-in, voice keybinds that work
while a game is in front, and its own updates.

From 2.0 it's an Electron app. 1.x was C# and WebView2, Windows only; see "Coming from 1.x".

## Install

| On | File (from the newest `desktop-vX.Y.Z` release) |
|---|---|
| Windows 10 / 11 | `Purrlor-Setup.exe`, a per-user installer (no admin rights) |
| Ubuntu, Debian, Mint, Pop!_OS | `purrlor_amd64.deb` (`sudo apt install ./purrlor_amd64.deb`, or open it in App Center) |
| Other Linux (x64) | `Purrlor-x86_64.AppImage`; it needs FUSE 2 (`libfuse2`) |

On Ubuntu, use the `.deb`: it sets up Chromium's sandbox and installs the AppArmor profile Ubuntu
24.04 and later need. Ubuntu 24.04 doesn't ship `libfuse2`, so the AppImage won't start there
without it.

## Choosing a server
On first launch the app asks **which Purrlor server** to connect to: the address you'd open Purrlor
at in a browser, e.g. `purr.meowops.net` (the default) or your own deployment's `app.example.com`.
It checks the address serves a Purrlor `config.json` first, and says so if it doesn't. The server
name in the title bar (or **Change server…** in the tray menu) switches it later.

That address is the Purrlor web client, not the Matrix homeserver. The server decides the rest: a
deployment locked to one homeserver (`PURRLOR_HOMESERVER_URL`) signs you in there, and an unlocked
one shows the usual homeserver field on its login screen. Each server keeps its own sign-in and
encryption keys (browser storage is per origin), so switching back picks up where you left off.

## Features
- Camera, microphone, screen share, notification and clipboard permissions granted to the configured
  server only (nothing is granted to any other site)
- A title bar of its own, with the system's window buttons drawn into it (Windows Snap layouts
  included), and screens of its own for loading, "couldn't connect" (it retries by itself, and as
  soon as the network is back) and the page crashing
- Screen sharing with Purrlor's own picker (screens and windows, with previews). On Windows it can
  share the computer's sound too. Under a Wayland session the system's own picker (the desktop
  portal) asks instead
- Native notifications (Windows' Action Center, or the Linux desktop's); clicking one opens the room
- The unread count on the taskbar button (Windows) or the dock (Ubuntu), and a dot on the tray icon
- Away after 10 minutes without keyboard or mouse, or when the screen locks (the page's setting)
- The keyboard's media keys and the system's media controls (Windows' flyout, MPRIS on Linux)
  drive Purrlor's music player
- Close to tray, so notifications keep arriving (Settings → Desktop can make the close button quit)
- Start on sign-in, in the tray
- Voice keybinds (push-to-talk, mute, deafen; set in Settings → Voice & Audio) that work while another
  window is in front. See "Keybinds and privacy"
- Right-click menus: spelling suggestions, cut/copy/paste, copy or save an image, open a link in the
  browser
- Zoom (Ctrl + / Ctrl − / Ctrl 0, or Ctrl + scroll), reload (F5), full screen (F11); Ctrl Q quits on Linux
- Links to other sites open in the default browser; downloads go to the Downloads folder
- Only one copy runs; launching it again brings the window back
- Keeps itself up to date (see "Updates")

## Where things live

| | Windows | Linux |
|---|---|---|
| Settings (`settings.json`), error log | `%LOCALAPPDATA%\Purrlor` | `~/.config/Purrlor` |
| Browser data (sign-ins, keys, cache) | `%LOCALAPPDATA%\Purrlor\App` | `~/.config/Purrlor` |
| The app | `%LOCALAPPDATA%\Programs\Purrlor` | `/opt/Purrlor` (.deb) or the AppImage file |
| Start on sign-in | the `Run` registry key | `~/.config/autostart/purrlor.desktop` |

Uninstalling removes the app but keeps the data. `PURRLOR_DATA_DIR` points all of it somewhere else,
for tests or for trying a build next to an installed copy.

## Settings
Purrlor's own Settings gets a **Desktop** tab inside the app: start on sign-in, what the close
button does, automatic updates, and the server. The app keeps these in its `settings.json`, not in
the page's storage.

## How it's put together
- `src/main/`: the main process. `app.ts` is the window: a `BrowserWindow` showing the shell page,
  with the Purrlor page in a `WebContentsView` under the title bar. The rest are its parts: the
  bridge, settings, the server address, updates, keybinds, idle, the tray, start on sign-in, the
  right-click menu.
- `src/shell/`: the shell page, the app's own UI (title bar, connect screen, loading and error
  screens, modals: change server, the screen-share picker, a one-time notice). Local files only. It
  draws to match the web client: its colours, square corners, Chakra Petch and Michroma (bundled).
  While a modal is up the page is hidden and a blurred still of it sits behind the modal.
- `src/preload/page.ts`: gives the Purrlor page the bridge; `src/preload/shell.ts`: gives the shell
  page its IPC.
- `scripts/build.mjs` bundles all of it into `dist/` with esbuild.

## The bridge
The page and the app talk over a message channel the preload puts at `window.chrome.webview`: the
shape WebView2 gave the 1.x app, so the web client (`apps/web/src/desktop/desktopBridge.ts`) works
with either. The app answers only the configured server's own top-level page and ignores anything
else. Every message is JSON tagged `"purrlor": 1`:

| Page asks (`method`) | Takes (`params`) | Answers (`result`) |
|---|---|---|
| `getInfo` | | `{ version, platform, settings: { startWithWindows, closeToTray, autoUpdate }, update }` |
| `setSetting` | `{ name, value }` (`startWithWindows`, `closeToTray` or `autoUpdate`, true/false) | the settings |
| `setHotkeys` | `{ bindings: [{ id, code, ctrl, alt, shift }] }` (`code` is a `KeyboardEvent.code`, or `Mouse4`/`Mouse5`; `[]` stops watching) | `{ unknown: [ids it can't watch] }` |
| `setBadge` | `{ count }` | nothing |
| `watchIdle` | `{ minutes }` (0 stops) | nothing; `idle` events follow |
| `checkForUpdates` | | the update state (below); `update` events follow |
| `installUpdate` | | nothing; the app restarts into the new version |
| `changeServer` | | nothing; the app opens its change-server screen |

`startWithWindows` means start on sign-in on Linux too (the name is the 1.x one); `platform`
(2.0 on) is Node's `process.platform`. A request is `{ purrlor: 1, id, method, params }` and its
answer `{ purrlor: 1, id, result }` or `{ purrlor: 1, id, error }`. The app also sends events unasked,
`{ purrlor: 1, event, data }`: `settings` when the tray menu changes one, `hotkey` (`{ id, down }`)
when a bound key goes down or up, `update` (`{ state, version, error, releaseUrl, automatic }`, also
in `getInfo`) as an update is checked for, downloaded and ready, and `idle` (`{ idle }`) when you
leave the computer or come back. The system's idle timer only says when the last input was, never
what it was. Desktop 1.0.0 has no bridge, so the page treats silence as "update the app".

## Keybinds and privacy
The keybinds work outside Purrlor because the app watches input system-wide through libuiohook
(`uiohook-napi`): Windows' low-level keyboard and mouse hooks, X11's record extension on Linux.
That sees every key pressed anywhere, so the app keeps its use narrow (`src/main/hotkeys.ts`):

- It runs only while the page has keys bound, which it does when you join a call, and it stops when
  you leave, sign out or the page reloads. Outside a call Purrlor watches nothing.
- Each press is compared with the bound keys and forgotten. Only a bound key going down or up is
  reported to the page, as `pushToTalk`, `mute` or `deafen`; no other key is stored, logged or sent.
- Keys are never swallowed: the game still gets them.

Windows doesn't pass a hook the input of a program running as administrator unless the hook's
program is too, so keybinds don't fire while such a game is in front. A Wayland session (Ubuntu's
default) lets no program watch keys globally at all, so there every binding comes back `unknown`
and the page uses keys that work while Purrlor is focused. Logging in to "Ubuntu on Xorg" makes
them global.

## Updates
The app keeps itself up to date (`src/main/updater.ts`). Two minutes after it starts, and every six
hours, it reads this repository's releases for a newer `desktop-vX.Y.Z`, downloads the file for how
it's installed into `Updates` beside its settings, and offers "Restart to update" in the title bar,
the tray menu and Settings → Desktop:

| Installed with | Downloads | Installs it |
|---|---|---|
| `Purrlor-Setup.exe` | `Purrlor-Setup.exe` | on restart, or quietly when you quit (`/S /RELAUNCH`) |
| the AppImage | `Purrlor-x86_64.AppImage` | on restart or quit, by swapping the file |
| the `.deb` | `purrlor_amd64.deb` | on restart only, with `apt` through `pkexec`, which asks for your password |

Settings → Desktop can switch the automatic checks off. A build run some other way (unpacked, or
from source) only says a new version is out, with a link.

There's no code-signing certificate, so the app checks updates against a key of its own: the release
workflow signs each file (`<file>.sig`, ECDSA P-256 over
`purrlor-desktop-update\n<version>\n<sha256 of the file>\n`, the signature as raw r‖s, base64) with
the `DESKTOP_UPDATE_SIGNING_KEY` Actions secret (`scripts/sign-update.mjs`), and the app holds the
public half (`purrlor.updatePublicKey` in `package.json`). A download that doesn't verify is deleted
and never run, it's checked again right before it's installed, and since the version is signed an
old file can't be passed off as a new one.

The private key exists only in that secret. If it's ever lost or leaked, make a new pair, put the new
public key in `package.json` and the private one in the secret: installed apps can't verify anything
signed with the new key, so that one release has to be installed by hand. To make a pair:

```
node -e "const k=require('crypto').generateKeyPairSync('ec',{namedCurve:'prime256v1'});console.log(k.publicKey.export({format:'der',type:'spki'}).toString('base64'));console.error(k.privateKey.export({format:'pem',type:'pkcs8'}))" 2> private.pem
gh secret set DESKTOP_UPDATE_SIGNING_KEY < private.pem
```

(and delete `private.pem`). A fork sets `purrlor.updateRepository` to its own repository and makes its
own pair; with `updatePublicKey` empty, its app only says when a new version is out.

## Coming from 1.x
The 2.0 installer is built to be installed by a 1.x app's own updater: the same installer name, the
same signature scheme, the same install folder, uninstall entry and `/S /RELAUNCH /TRAY` switches. It
replaces the old .NET files and keeps `settings.json` (server, window, start with Windows, close to
tray, automatic updates).

Sign-ins don't come over: they lived in WebView2's profile (`%LOCALAPPDATA%\Purrlor\WebView2`), which
Chromium can't read. The first time 2.0 opens it says so once and asks people to sign in again, with
their recovery key or passphrase ready if they use encrypted chats. The old `WebView2` folder is left
where it was.

## Build
Needs Node.js 22. In `apps/desktop`:

```
npm ci
npm start              # build and run from source
npm run typecheck
npm test
npm run dist:win       # on Windows, with NSIS: dist-app\Purrlor-Setup.exe
npm run dist:linux     # on Linux: dist-app/Purrlor-x86_64.AppImage and purrlor_amd64.deb
```

Under `npm start`, F12 opens the developer tools (a packaged build needs `PURRLOR_DEVTOOLS=1`).

## Release
Bump `version` in `package.json`, add `release-notes/vX.Y.Z.md` (or the release gets
`release-notes/default.md`), then push a matching tag:

```
git tag desktop-v2.0.0
git push origin desktop-v2.0.0
```

The `Desktop` workflow typechecks and tests, builds the Windows installer and the Linux packages,
signs each for auto-update, and publishes them as one GitHub release.
