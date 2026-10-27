# purrlor-tui

A small, fun terminal client for Purrlor (Matrix Spaces = "servers", rooms in a Space = channels).
One static Go binary, with end-to-end encryption (pure-Go olm + pure-Go SQLite, no cgo).

## Install

Download `purrlor-tui-linux-amd64` (or `-arm64`) from the newest `tui-v*` release on the
[releases page](https://github.com/m0nnnna/Purrlor/releases), then:

```sh
chmod +x purrlor-tui-linux-amd64 && mv purrlor-tui-linux-amd64 ~/.local/bin/purrlor-tui
purrlor-tui
```

At the login screen, enter a Purrlor site (`purr.meowops.net` by default) or any Matrix homeserver:
a Purrlor site's `/config.json` says which homeserver it uses, otherwise `.well-known` is followed.

## Build

```sh
CGO_ENABLED=0 go build -tags goolm -ldflags "-s -w" -o purrlor-tui .
./purrlor-tui
```

Releases: set nothing in the code, just push a tag `tui-vX.Y.Z`; `.github/workflows/tui.yml` builds
the binaries with that version (`purrlor-tui --version`) and publishes the release.

## Flags

| Flag | Meaning |
|---|---|
| `--compact` | IRC-style one-line messages (`14:02 <floof> text`) |
| `--no-bell` | no terminal bell on mentions |
| `--logout` | log out, delete the saved session and crypto database, exit |
| `--version` | print the version |

## Files

- `~/.config/purrlor/session.json` (0600): homeserver, user, device, access token, crypto pickle key
- `~/.local/share/purrlor/crypto.db`: E2EE keys (losing it means losing the ability to read old encrypted history)

## Keys

| Key | Action |
|---|---|
| Enter | send |
| Tab / Shift+Tab, Alt+Down / Alt+Up | next / previous channel |
| Click a Space or channel | open it (the mouse wheel scrolls the chat; hold Shift to select text) |
| Alt+1 … Alt+9 | open Space 1–9 as numbered in the sidebar ("Direct", first, holds DMs and rooms outside any Space) |
| Alt+→ / Alt+← (also Ctrl+N / Ctrl+P, Ctrl+Down / Ctrl+Up) | next / previous Space |
| Ctrl+K | fuzzy channel jump (type, Up/Down, Enter, Esc) |
| PgUp / PgDn | scroll; scrolling past the top loads older history |
| Up / Down | pick a message (the status bar then lists what you can do with it); Esc clears |
| `r` or Enter | reply to the picked message (the composer shows `↳ name`) |
| `e` | react: `1`–`6` for 👍 ❤️ 😂 🐾 😮 😢, or type any emoji and Enter; reacting again takes it back |
| `i` | edit your own message (the composer shows `✎ editing`; Esc cancels) |
| `d` `d` | delete your own message (press twice) |
| `y` | copy the message text (needs `wl-copy`) |
| `o` | open the picked message's image/file |
| Alt+O | open the selected (or last) image/file |
| Ctrl+C | quit |

Commands: `/me <text>`, `/react <emoji>` (selected or last message), `/reply <text>`, `/purr`
(random cat), `/open`, `/join` (accept an invite), `/help`, `/quit`.

Attachments are downloaded (and decrypted if needed) to a temp dir and opened with `xdg-open`.

Header cat: `=^.^=` all caught up, `=O.O=` unread mention, `=-.-=` idle for 5 minutes.
`ᓚᘏᗢ` walks the status bar during the first sync.

## Not supported (yet)

- voice/video (voice channels show with 🔊 but there is no audio)
- posts, stories, feeds (feed rooms are hidden)
- device verification / cross-signing / key backup: encrypted history sent before this device
  existed shows as "🔒 encrypted (can't decrypt yet)" until another device shares keys
- sending files/images, editing or deleting your messages, creating/joining rooms other than via invite
- room state is kept in memory, so every start does a (filtered) full initial sync
