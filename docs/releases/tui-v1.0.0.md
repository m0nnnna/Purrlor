The first release of **purrlor-tui**, Purrlor in a terminal: one static Linux binary, nothing to install.

```sh
chmod +x purrlor-tui-linux-amd64 && mv purrlor-tui-linux-amd64 ~/.local/bin/purrlor-tui
purrlor-tui
```

- Sign in to a Purrlor site (`purr.meowops.net` by default) or any Matrix homeserver; the session is kept.
- Spaces and their channels in a sidebar, with unread dots and mention counts. Click them, or
  Alt+1–9 / Alt+←→ for Spaces, Tab and Ctrl+K for channels. Rooms from other servers that share
  a name are marked with where they're from.
- Messages with replies, reactions, edits and typing; end-to-end encryption.
- Pick a message with ↑ to reply (`r`), react (`e`), edit (`i`) or delete (`d d`) your own, copy
  (`y`) or open its image or file (`o`).
- `/purr`, `/me`, `--compact` IRC-style lines, and a cat that watches your mentions.

Not in this release: voice and video calls, posts and stories, and device verification.
See [apps/tui/README.md](https://github.com/m0nnnna/Purrlor/blob/master/apps/tui/README.md).
