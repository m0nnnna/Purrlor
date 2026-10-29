/**
 * What the main process and the shell page (src/shell, the app's own UI: title bar, connect
 * screen, loading and error screens, the screen-share picker) say to each other. The Purrlor page
 * itself never sees any of this; it talks over the bridge (src/preload/page.ts).
 */
import type { UpdateStatus } from '../main/updater';

export type { UpdateStatus };

export type View = 'loading' | 'connect' | 'error' | 'crashed' | 'page';

export type PickerSource = {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string;
  icon: string | null;
};

export type Modal =
  | { kind: 'connect' }
  | { kind: 'picker'; sources: PickerSource[]; audio: boolean }
  | { kind: 'notice'; title: string; body: string };

export type ShellState = {
  platform: string;
  version: string;
  /** The page's title (it carries the unread count). */
  title: string;
  server: { origin: string; name: string } | null;
  view: View;
  /** The connect screen with no server to go back to. */
  firstRun: boolean;
  error: { title: string; detail: string } | null;
  modal: Modal | null;
  /** A still of the page, shown under a modal while the page itself is hidden. */
  backdrop: string | null;
  update: UpdateStatus;
  maximized: boolean;
  focused: boolean;
  fullscreen: boolean;
};

export type ProbeResult =
  | { ok: true; origin: string; name: string; problem: string | null }
  | { ok: false; error: string };

export type ShellApi = {
  onState(listener: (state: ShellState) => void): void;
  onDrawBadge(listener: (request: { id: number; count: number }) => void): void;
  badgeDrawn(id: number, overlay: string | null, tray: string): void;
  probe(address: string): Promise<ProbeResult>;
  connect(origin: string): void;
  cancelModal(): void;
  retry(): void;
  changeServer(): void;
  choosePickerSource(id: string, audio: boolean): void;
  installUpdate(): void;
  dismissNotice(): void;
  openExternal(url: string): void;
};
