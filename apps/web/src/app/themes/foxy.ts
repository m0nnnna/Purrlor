/**
 * The Foxy preset: the app's first light theme. Warm cream paper, ink-brown text and a fox's
 * orange as the accent, with a berry pink for the things about you (mentions, moderators).
 *
 * Only token overrides (docs/theming.md), like most presets. Being light, it also sets:
 * - `--nu-color-scheme: light`, so the browser's own controls (checkboxes, menus, scrollbars)
 *   come out light too;
 * - `--nu-name-ink-mix`, so the pale per-person name colors that read well on the dark themes
 *   are darkened enough to read on cream (MessageTimeline's sender names, nameColor.ts);
 * - white on the accent: the orange is deep enough to carry it.
 */
export const FOXY_CSS = `/* Foxy: a light theme in fox orange. */
:root {
  --nu-color-scheme: light;

  --nu-color-bg-app: #f3e3d3;
  --nu-color-bg-primary: #fbf1e7;
  --nu-color-bg-secondary: #fffaf5;
  --nu-color-bg-tertiary: #f5e6d8;
  --nu-color-bg-elevated: #ffffff;

  --nu-color-text-primary: #2d1b10;
  --nu-color-text-secondary: #6a4a36;
  --nu-color-text-muted: #94735e;
  --nu-color-text-link: #c2410c;

  --nu-color-accent: #e8590c;
  --nu-color-accent-hover: #f76707;
  --nu-color-accent-2: #c2255c;
  --nu-color-accent-2-hover: #d6336c;
  --nu-color-on-accent: #ffffff;

  --nu-color-danger: #d6293e;
  --nu-color-danger-2: #e8590c;
  --nu-color-success: #2b8a3e;
  --nu-color-warning: #b35c00;
  --nu-color-role-admin: #d9480f;
  --nu-color-role-moderator: #c2255c;

  --nu-color-border: #e8d3c0;
  --nu-color-backdrop: rgba(61, 33, 14, 0.38);
  --nu-color-backdrop-strong: rgba(20, 10, 4, 0.9);

  --nu-gradient-accent: linear-gradient(180deg, #f76707, #e8590c);
  --nu-gradient-accent-hover: linear-gradient(180deg, #ff7a1a, #f76707);
  --nu-gradient-accent-diagonal: linear-gradient(160deg, #ff922b, #e8590c);

  --nu-name-ink-mix: 55%;

  /* The shard wallpaper, light: white shards laid on (not added to) a cream-to-clay ground. */
  --nu-wall-ground-start: #fbf1e7;
  --nu-wall-ground-end: #e3b896;
  --nu-wall-shard: #ffffff;
  --nu-wall-edge: rgba(106, 74, 54, 0.4);
  --nu-wall-grid: #6a4a36;
  --nu-wall-shade: #6a4a36;
  --nu-wall-blend: normal;
  --nu-frame-shadow: 0 24px 70px rgba(61, 33, 14, 0.18);

  scrollbar-color: #e2c4a8 transparent;
}

::selection {
  background: #ffd8a8;
  color: #2d1b10;
}

.nu-button--primary {
  box-shadow: 0 4px 14px -6px rgba(232, 89, 12, 0.6);
}
`;
