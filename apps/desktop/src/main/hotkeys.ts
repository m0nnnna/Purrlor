import { keyCodeFor, mouseCodeFor } from './keycodes';
import { logError } from './paths';

/**
 * The call's keybinds (push-to-talk, mute, deafen), watched system-wide so they work while another
 * window, a game say, is in front. The page sets them over the bridge (`setHotkeys`) when a call
 * starts and clears them when it ends.
 *
 * libuiohook (Windows' low-level hooks, X11's XRecord) sees every key pressed anywhere, so what
 * this does with them is kept narrow: each press is compared with the bound keys and forgotten.
 * Only a bound key going down or up is reported, as the binding's id; no other key is stored,
 * logged or sent. Nothing is swallowed: the game still gets the key. The hook runs only while
 * something is bound, so outside a call Purrlor isn't watching at all.
 */
export type WantedBinding = { id: string; code: string; ctrl: boolean; alt: boolean; shift: boolean };
type Binding = { id: string; key: number; ctrl: boolean; alt: boolean; shift: boolean };

type KeyEvent = { keycode: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };
type MouseEvent = { button: unknown; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };
type Hook = {
  on(event: 'keydown' | 'keyup', l: (e: KeyEvent) => void): void;
  on(event: 'mousedown' | 'mouseup', l: (e: MouseEvent) => void): void;
  removeAllListeners(): void;
  start(): void;
  stop(): void;
};

export class GlobalHotkeys {
  private bindings: Binding[] = [];
  private readonly held = new Set<string>();
  private hook: Hook | null = null;
  private running = false;

  /**
   * @param report a binding's id and whether it went down
   * @param available false where no global hook can work (a Wayland session): every binding is
   * then "unknown", and the page falls back to keys that work while Purrlor is focused.
   */
  constructor(
    private readonly report: (id: string, down: boolean) => void,
    private readonly available: boolean,
    private readonly load: () => Hook = () => require('uiohook-napi').uIOhook as Hook
  ) {}

  /** Replaces the bindings. Returns the ids of any whose key this can't watch. */
  set(wanted: WantedBinding[]): string[] {
    const unknown: string[] = [];
    const next: Binding[] = [];
    for (const w of wanted) {
      const key = this.available ? keyCodeFor(w.code) : null;
      if (key === null) unknown.push(w.id);
      else next.push({ id: w.id, key, ctrl: w.ctrl, alt: w.alt, shift: w.shift });
    }
    // Anything held under the old bindings is let go of, so push-to-talk can't stick open.
    for (const id of this.held) this.report(id, false);
    this.held.clear();
    this.bindings = next;
    if (next.length > 0) {
      if (!this.start()) return wanted.map((w) => w.id);
    } else this.stop();
    return unknown;
  }

  clear(): void {
    this.set([]);
  }

  dispose(): void {
    this.stop();
  }

  /** Exposed for tests: what the hook calls. */
  handle(key: number, down: boolean, mods: { ctrl: boolean; alt: boolean; shift: boolean }): void {
    for (const b of this.bindings) {
      if (b.key !== key) continue;
      if (down) {
        if (this.held.has(b.id)) continue; // key repeat
        // A binding without modifiers ignores them (Shift held to run doesn't stop push-to-talk);
        // one with modifiers needs exactly those, the same as the page's matchesKey.
        const hasMods = b.ctrl || b.alt || b.shift;
        if (hasMods && (mods.ctrl !== b.ctrl || mods.alt !== b.alt || mods.shift !== b.shift)) continue;
        this.held.add(b.id);
        this.report(b.id, true);
      } else if (this.held.delete(b.id)) {
        this.report(b.id, false);
      }
    }
  }

  private start(): boolean {
    if (this.running) return true;
    try {
      if (!this.hook) {
        this.hook = this.load();
      }
      const hook = this.hook;
      hook.removeAllListeners();
      const mods = (e: KeyEvent | MouseEvent) => ({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
      hook.on('keydown', (e) => this.handle(e.keycode, true, mods(e)));
      hook.on('keyup', (e) => this.handle(e.keycode, false, mods(e)));
      hook.on('mousedown', (e) => {
        const key = mouseCodeFor(e.button);
        if (key !== null) this.handle(key, true, mods(e));
      });
      hook.on('mouseup', (e) => {
        const key = mouseCodeFor(e.button);
        if (key !== null) this.handle(key, false, mods(e));
      });
      hook.start();
      this.running = true;
      return true;
    } catch (err) {
      logError('keybinds', err);
      this.bindings = [];
      return false;
    }
  }

  private stop(): void {
    if (!this.running || !this.hook) return;
    try {
      this.hook.stop();
      this.hook.removeAllListeners();
    } catch (err) {
      logError('keybinds stop', err);
    }
    this.running = false;
  }
}
