import { describe, expect, it } from 'vitest';
import { bindingFromEvent, keyLabel, matchesKey, mouseBinding, parseBinding } from './voiceKeybinds';

const press = (code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

describe('bindingFromEvent', () => {
  it('writes modifiers before the key, in a fixed order', () => {
    expect(bindingFromEvent(press('KeyM', { shift: true, ctrl: true }))).toBe('Ctrl+Shift+KeyM');
  });

  it('takes a modifier pressed on its own as the key itself', () => {
    // Right Ctrl, the push-to-talk default, reports ctrlKey while it's down.
    expect(bindingFromEvent(press('ControlRight', { ctrl: true }))).toBe('ControlRight');
  });
});

describe('matchesKey', () => {
  it('ignores modifiers for a plain key, so push-to-talk works while running with Shift held', () => {
    expect(matchesKey(parseBinding('KeyV')!, press('KeyV', { shift: true }))).toBe(true);
  });

  it('needs exactly the modifiers of a combination', () => {
    const binding = parseBinding('Ctrl+KeyM')!;
    expect(matchesKey(binding, press('KeyM', { ctrl: true }))).toBe(true);
    expect(matchesKey(binding, press('KeyM'))).toBe(false);
    // Ctrl+Shift+M is somebody else's shortcut, not this one.
    expect(matchesKey(binding, press('KeyM', { ctrl: true, shift: true }))).toBe(false);
  });

  it('never matches a different key', () => {
    expect(matchesKey(parseBinding('KeyV')!, press('KeyB'))).toBe(false);
  });
});

describe('parseBinding', () => {
  it('is null for no binding', () => {
    expect(parseBinding('')).toBeNull();
  });

  it('splits modifiers from the key', () => {
    expect(parseBinding('Alt+Shift+F9')).toEqual({ code: 'F9', ctrl: false, alt: true, shift: true });
  });
});

describe('mouseBinding', () => {
  it('names the side buttons and nothing else', () => {
    expect(mouseBinding(3)).toBe('Mouse4');
    expect(mouseBinding(4)).toBe('Mouse5');
    expect(mouseBinding(0)).toBeNull();
  });
});

describe('keyLabel', () => {
  it('reads combinations and mouse buttons the way people say them', () => {
    expect(keyLabel('Ctrl+Shift+KeyM')).toBe('Ctrl+Shift+M');
    expect(keyLabel('Mouse4')).toBe('Mouse 4');
    expect(keyLabel('ControlRight')).toBe('Ctrl Right');
    expect(keyLabel('')).toBe('Not set');
  });
});
