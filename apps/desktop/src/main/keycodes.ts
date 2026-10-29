/**
 * KeyboardEvent.code (a physical key, the same whatever the layout) to libuiohook's key code,
 * which is the key's scan code. "Mouse4" and "Mouse5" are the side buttons, as the page names them.
 */
export const MOUSE4 = -4;
export const MOUSE5 = -5;

const named: Record<string, number> = {
  Mouse4: MOUSE4,
  Mouse5: MOUSE5,
  Escape: 0x0001, Backquote: 0x0029, Minus: 0x000c, Equal: 0x000d, Backspace: 0x000e, Tab: 0x000f,
  BracketLeft: 0x001a, BracketRight: 0x001b, Backslash: 0x002b, CapsLock: 0x003a, Semicolon: 0x0027,
  Quote: 0x0028, Enter: 0x001c, Comma: 0x0033, Period: 0x0034, Slash: 0x0035, Space: 0x0039,
  IntlBackslash: 0x0056,
  ShiftLeft: 0x002a, ShiftRight: 0x0036, ControlLeft: 0x001d, ControlRight: 0x0e1d,
  AltLeft: 0x0038, AltRight: 0x0e38, MetaLeft: 0x0e5b, MetaRight: 0x0e5c, ContextMenu: 0x0e5d,
  PrintScreen: 0x0e37, ScrollLock: 0x0046, Pause: 0x0e45,
  Insert: 0x0e52, Delete: 0x0e53, Home: 0x0e47, End: 0x0e4f, PageUp: 0x0e49, PageDown: 0x0e51,
  ArrowUp: 0xe048, ArrowLeft: 0xe04b, ArrowRight: 0xe04d, ArrowDown: 0xe050,
  NumLock: 0x0045, NumpadDivide: 0x0e35, NumpadMultiply: 0x0037, NumpadSubtract: 0x004a,
  NumpadAdd: 0x004e, NumpadEnter: 0x0e1c, NumpadDecimal: 0x0053,
  Numpad0: 0x0052, Numpad1: 0x004f, Numpad2: 0x0050, Numpad3: 0x0051, Numpad4: 0x004b,
  Numpad5: 0x004c, Numpad6: 0x004d, Numpad7: 0x0047, Numpad8: 0x0048, Numpad9: 0x0049,
};

const letters = 'QWERTYUIOP';
const homeRow = 'ASDFGHJKL';
const bottomRow = 'ZXCVBNM';
for (let i = 0; i < letters.length; i++) named[`Key${letters[i]}`] = 0x10 + i;
for (let i = 0; i < homeRow.length; i++) named[`Key${homeRow[i]}`] = 0x1e + i;
for (let i = 0; i < bottomRow.length; i++) named[`Key${bottomRow[i]}`] = 0x2c + i;
for (let d = 1; d <= 9; d++) named[`Digit${d}`] = 0x01 + d;
named.Digit0 = 0x0b;
const fKeys = [0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x57, 0x58, 0x5b, 0x5c, 0x5d, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b];
fKeys.forEach((code, i) => (named[`F${i + 1}`] = code));

export function keyCodeFor(code: string): number | null {
  return Object.prototype.hasOwnProperty.call(named, code) ? named[code] : null;
}

/** libuiohook's mouse buttons: 4 is back (the page's Mouse4), 5 is forward. */
export function mouseCodeFor(button: unknown): number | null {
  if (button === 4) return MOUSE4;
  if (button === 5) return MOUSE5;
  return null;
}
