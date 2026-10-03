import { useEffect, useRef, useState } from 'react';
import { useLocalParticipant } from '@livekit/components-react';
import { desktopBridge } from '../../desktop/desktopBridge';
import { toggleDeafen, toggleMute } from './callActions';
import { useVoiceCall } from './voiceCallContext';
import {
  bindingFor,
  matchesKey,
  mouseBinding,
  parseBinding,
  useKeybinds,
  useRebinding,
  type KeybindAction,
  type ParsedBinding,
} from './voiceKeybinds';

const ACTIONS: KeybindAction[] = ['pushToTalk', 'mute', 'deafen'];

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

/**
 * The call's keybinds (voiceKeybinds.ts): push-to-talk, and keys that toggle mute and deafen. Lives
 * at call level (inside ActiveVoiceCall), so they work whichever channel you're looking at.
 *
 * In the desktop app the keys are watched system-wide (`setHotkeys`), so they work in a game too;
 * the app reports only these keys and only while you're in a call. In a browser, or a desktop app
 * too old to watch them, they work while Purrlor has focus. Renders nothing.
 */
export function CallHotkeys() {
  const { localParticipant } = useLocalParticipant();
  const call = useVoiceCall();
  const binds = useKeybinds();
  const rebinding = useRebinding() !== null;
  const [global, setGlobal] = useState(false);
  const pttHeld = useRef(false);

  // Handlers read the latest state through this, so the listeners below needn't be re-added
  // every time you mute.
  const latest = useRef({ localParticipant, call, binds });
  latest.current = { localParticipant, call, binds };

  const actions = useRef({
    down(action: KeybindAction) {
      const { localParticipant: lp, call: c, binds: b } = latest.current;
      if (!c) return;
      if (action === 'pushToTalk') {
        if (pttHeld.current) return;
        pttHeld.current = true;
        if (!c.deafened) void lp.setMicrophoneEnabled(true);
      } else if (action === 'mute') {
        // With push-to-talk on, the key you hold is what opens the mic.
        if (!b.pushToTalk) toggleMute(lp, c.deafened, c.setDeafened);
      } else {
        toggleDeafen(lp, c.deafened, c.setDeafened);
      }
    },
    up(action: KeybindAction) {
      if (action !== 'pushToTalk' || !pttHeld.current) return;
      pttHeld.current = false;
      void latest.current.localParticipant.setMicrophoneEnabled(false);
    },
    /** A key can't be let go of once nothing is listening for it, so the mic is closed here. */
    releaseAll() {
      if (pttHeld.current) actions.current.up('pushToTalk');
    },
  });

  // Push-to-talk mutes you on the way in, and turning it off hands the mic back: otherwise you'd
  // be left silently muted with a control bar that looks unmuted.
  const wasPushToTalk = useRef(binds.pushToTalk);
  useEffect(() => {
    if (binds.pushToTalk) void localParticipant.setMicrophoneEnabled(false);
    else if (wasPushToTalk.current) void localParticipant.setMicrophoneEnabled(true);
    wasPushToTalk.current = binds.pushToTalk;
  }, [binds.pushToTalk, localParticipant]);

  const bindings = ACTIONS.map((action) => ({ action, binding: parseBinding(bindingFor(binds, action)) })).filter(
    (b): b is { action: KeybindAction; binding: ParsedBinding } => b.binding !== null
  );
  const bindingsKey = JSON.stringify(bindings);

  // The desktop app: watch these keys system-wide while the call lasts.
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    const act = actions.current;
    let cancelled = false;
    const list = rebinding ? [] : (JSON.parse(bindingsKey) as typeof bindings);
    bridge
      .request('setHotkeys', { bindings: list.map(({ action, binding }) => ({ id: action, ...binding })) })
      .then(() => !cancelled && setGlobal(true))
      // Desktop 1.0.0 can't: the keys work while Purrlor has focus instead.
      .catch(() => !cancelled && setGlobal(false));
    const off = bridge.on('hotkey', (data) => {
      const { id, down } = data as { id: KeybindAction; down: boolean };
      if (!ACTIONS.includes(id)) return;
      if (down) act.down(id);
      else act.up(id);
    });
    return () => {
      cancelled = true;
      off();
      act.releaseAll();
      bridge.request('setHotkeys', { bindings: [] }).catch(() => undefined);
    };
  }, [bindingsKey, rebinding]);

  // In the page, when the desktop app isn't watching the keys for us.
  useEffect(() => {
    if (global || rebinding) return;
    const act = actions.current;
    const list = JSON.parse(bindingsKey) as typeof bindings;
    const onKeyDown = (evt: KeyboardEvent) => {
      for (const { action, binding } of list) {
        if (!matchesKey(binding, evt)) continue;
        if (action === 'pushToTalk') {
          act.down(action);
        } else if (!evt.repeat) {
          // A plain key (no Ctrl/Alt/Shift) bound to mute is still a letter while you type.
          if (!binding.ctrl && !binding.alt && !binding.shift && isTyping(evt.target)) continue;
          evt.preventDefault();
          act.down(action);
        }
      }
    };
    const onKeyUp = (evt: KeyboardEvent) => {
      if (list.some((b) => b.action === 'pushToTalk' && b.binding.code === evt.code)) act.up('pushToTalk');
    };
    const onMouse = (evt: MouseEvent) => {
      const code = mouseBinding(evt.button);
      if (!code) return;
      for (const { action, binding } of list) {
        if (binding.code !== code) continue;
        if (evt.type === 'mousedown') act.down(action);
        else act.up(action);
      }
    };
    // capture: true, so a key let go of after focus has moved elsewhere still counts.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousedown', onMouse, true);
    window.addEventListener('mouseup', onMouse, true);
    // Switching away mid-hold: the key-up goes to another window, so let go here.
    const onBlur = () => act.releaseAll();
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('mouseup', onMouse, true);
      window.removeEventListener('blur', onBlur);
      act.releaseAll();
    };
  }, [global, rebinding, bindingsKey]);

  // A mouse side button bound to a keybind is the browser's Back and Forward otherwise.
  useEffect(() => {
    const codes = new Set((JSON.parse(bindingsKey) as typeof bindings).map((b) => b.binding.code));
    if (!codes.has('Mouse4') && !codes.has('Mouse5')) return;
    const swallow = (evt: MouseEvent) => {
      const code = mouseBinding(evt.button);
      if (code && codes.has(code)) evt.preventDefault();
    };
    window.addEventListener('mouseup', swallow, true);
    window.addEventListener('auxclick', swallow, true);
    return () => {
      window.removeEventListener('mouseup', swallow, true);
      window.removeEventListener('auxclick', swallow, true);
    };
  }, [bindingsKey]);

  return null;
}
