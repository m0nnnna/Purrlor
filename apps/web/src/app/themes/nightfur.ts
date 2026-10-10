/**
 * The Nightfur preset: Purrlor's default look before the Ultimit redesign. A cat out after dark:
 * ink-violet surfaces, lilac-grey text, one catseye gold accent and sakura pink for the things that
 * are about you.
 *
 * Besides its colors, fonts and soft corners it turns the Ultimit frame off (styles/tokens.css,
 * "Frame"): no wallpaper, no gaps or glass between the columns, no corner brackets, no cut corners,
 * and labels back in ordinary type. It brings its own fonts, since the app no longer loads them.
 */
export const NIGHTFUR_CSS = `/* Nightfur: the previous default look. */
@import url('https://fonts.googleapis.com/css2?family=Dela+Gothic+One&family=Figtree:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap');

:root {
  --nu-color-bg-app: #0d0a13;
  --nu-color-bg-primary: #14101c;
  --nu-color-bg-secondary: #1a1524;
  --nu-color-bg-tertiary: #241e31;
  --nu-color-bg-elevated: #2d2640;

  --nu-color-text-primary: #f4effa;
  --nu-color-text-secondary: #bdb1d0;
  --nu-color-text-muted: #7f7394;
  --nu-color-text-link: #ffcb7a;

  --nu-color-accent: #ffb547;
  --nu-color-accent-hover: #ffc56e;
  --nu-color-accent-2: #ff7ab6;
  --nu-color-accent-2-hover: #ff97c6;
  --nu-color-danger: #ff5c6c;
  --nu-color-danger-2: #ff8a5c;
  --nu-color-success: #4ade9b;
  --nu-color-warning: #ffd166;
  --nu-color-on-accent: #1a1206;
  --nu-color-role-admin: #ffb547;
  --nu-color-role-moderator: #ff7ab6;

  --nu-color-border: #2b2439;
  --nu-color-border-strong: #4a3f5e;
  --nu-color-backdrop: rgba(6, 4, 10, 0.72);
  --nu-color-backdrop-strong: rgba(6, 4, 10, 0.92);

  --nu-gradient-accent: linear-gradient(180deg, var(--nu-color-accent-hover), var(--nu-color-accent));

  --nu-color-panel: var(--nu-color-bg-primary);
  --nu-color-panel-main: var(--nu-color-bg-secondary);
  --nu-color-rail: var(--nu-color-bg-app);
  --nu-color-hover: var(--nu-color-bg-tertiary);
  --nu-frame-gap: 0px;
  --nu-frame-blur: 0px;
  --nu-frame-shadow: none;
  --nu-frame-bracket: transparent;
  --nu-clip-cut: none;
  --nu-clip-avatar: none;
  --nu-label-transform: none;
  --nu-label-tracking: 0.02em;
  --nu-wallpaper-opacity: 0;
  --nu-post-background: var(--nu-color-bg-primary);
  --nu-post-border: 1px solid var(--nu-color-border);
  --nu-post-divider: 1px solid var(--nu-color-border);
  --nu-post-radius: var(--nu-radius-lg);
  --nu-post-padding: var(--nu-space-4);
  --nu-composer-label-display: none;

  --nu-radius-sm: 6px;
  --nu-radius-md: 8px;
  --nu-radius-lg: 14px;
  --nu-radius-tile: 13px;
  --nu-radius-avatar: 9999px;
  --nu-radius-dot: 9999px;

  --nu-font-body: 'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --nu-font-display: 'Dela Gothic One', var(--nu-font-body);
  --nu-font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --nu-font-label: var(--nu-font-body);

  --nu-width-server-rail: 72px;
  --nu-rail-label-display: none;
  --nu-rail-row-gap: var(--nu-space-4);
}
`;
