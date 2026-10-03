import { useSyncExternalStore } from 'react';

/**
 * Voice keybinds: push-to-talk, and keys that toggle mute and deafen. Per device (localStorage),
 * like the rest of how you set up your own audio. CallHotkeys acts on them for the whole call; in
 * the desktop app they work while Purrlor isn't focused too (desktop/desktopBridge.ts, `setHotkeys`).
 *
 * A binding is a string: modifiers then a key, joined by '+', e.g. "Ctrl+Shift+KeyM". The key is a
 * `KeyboardEvent.code` (a physical key, so it's the same key whatever the keyboard layout), or
 * "Mouse4"/"Mouse5" for a mouse's side buttons. '' means not bound.
 */
export type Keybinds = {
  pushToTalk: boolean;
  pushToTalkKey: string;
  muteKey: string;
  deafenKey: string;
};

export type KeybindAction = 'pushToTalk' | 'mute' | 'deafen';

// The push-to-talk keys predate this file; they keep their names so nobody's binding is lost.
const PTT_ENABLED_KEY = 'nekous_ptt_enabled';
const PTT_KEY_KEY = 'nekous_ptt_key';
const MUTE_KEY_KEY = 'nekous_mute_key';
const DEAFEN_KEY_KEY = 'nekous_deafen_key';

// Right Ctrl by default (not Left): a key nobody's regular typing or the composer's own shortcuts
// (Enter, Shift+Enter, arrow keys for mentions/commands) ever touches, so push-to-talk works the
// same whether or not the message box happens to be focused.
export const DEFAULT_PTT_KEY = 'ControlRight';

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function set(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered this time; it still applies now.
  }
}

function load(): Keybinds {
  return {
    pushToTalk: get(PTT_ENABLED_KEY) === 'true',
    pushToTalkKey: get(PTT_KEY_KEY) || DEFAULT_PTT_KEY,
    muteKey: get(MUTE_KEY_KEY) ?? '',
    deafenKey: get(DEAFEN_KEY_KEY) ?? '',
  };
}

let current: Keybinds | null = null;
/** Which action's key is being chosen. Meanwhile no keybind acts, so the key pressed only gets bound. */
let rebinding: KeybindAction | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readKeybinds(): Keybinds {
  current ??= load();
  return current;
}

export function saveKeybinds(changes: Partial<Keybinds>): void {
  current = { ...readKeybinds(), ...changes };
  set(PTT_ENABLED_KEY, String(current.pushToTalk));
  set(PTT_KEY_KEY, current.pushToTalkKey);
  set(MUTE_KEY_KEY, current.muteKey);
  set(DEAFEN_KEY_KEY, current.deafenKey);
  notify();
}

export function useKeybinds(): Keybinds {
  return useSyncExternalStore(subscribe, readKeybinds);
}

export function setRebinding(action: KeybindAction | null): void {
  if (rebinding === action) return;
  rebinding = action;
  notify();
}

export function useRebinding(): KeybindAction | null {
  return useSyncExternalStore(subscribe, () => rebinding);
}

/** The binding for an action ('' when it has none, or push-to-talk is off). */
export function bindingFor(binds: Keybinds, action: KeybindAction): string {
  if (action === 'pushToTalk') return binds.pushToTalk ? binds.pushToTalkKey : '';
  return action === 'mute' ? binds.muteKey : binds.deafenKey;
}

export type ParsedBinding = { code: string; ctrl: boolean; alt: boolean; shift: boolean };

export function parseBinding(binding: string): ParsedBinding | null {
  if (!binding) return null;
  const parts = binding.split('+');
  const code = parts.pop() ?? '';
  if (!code) return null;
  return { code, ctrl: parts.includes('Ctrl'), alt: parts.includes('Alt'), shift: parts.includes('Shift') };
}

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
]);

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

/** The binding a key press makes. A modifier on its own is a key in itself (Right Ctrl). */
export function bindingFromEvent(evt: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string {
  if (isModifierCode(evt.code)) return evt.code;
  return [evt.ctrlKey && 'Ctrl', evt.altKey && 'Alt', evt.shiftKey && 'Shift', evt.code].filter(Boolean).join('+');
}

/** The mouse's side buttons, as MouseEvent.button numbers them (3 back, 4 forward). */
export function mouseBinding(button: number): string | null {
  return button === 3 ? 'Mouse4' : button === 4 ? 'Mouse5' : null;
}

/**
 * Whether a key press is this binding. One without modifiers ignores them, so holding Shift to run
 * in a game doesn't stop push-to-talk working; one with modifiers needs exactly those.
 */
export function matchesKey(binding: ParsedBinding, evt: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
  if (evt.code !== binding.code) return false;
  if (!binding.ctrl && !binding.alt && !binding.shift) return true;
  return evt.ctrlKey === binding.ctrl && evt.altKey === binding.alt && evt.shiftKey === binding.shift;
}

/** "KeyV" → "V", "ControlRight" → "Ctrl Right", "Ctrl+Shift+KeyM" → "Ctrl+Shift+M", "Mouse4" → "Mouse 4". */
export function keyLabel(binding: string): string {
  if (!binding) return 'Not set';
  return binding
    .split('+')
    .map((part) =>
      part
        .replace(/^(Key|Digit)/, '')
        .replace(/^Numpad/, 'Num ')
        .replace(/^Control/, 'Ctrl')
        .replace(/^Mouse(\d)$/, 'Mouse $1')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
    )
    .join('+');
}
