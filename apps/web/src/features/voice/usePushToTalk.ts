import { useCallback, useEffect } from 'react';
import {
  bindingFromEvent,
  keyLabel,
  mouseBinding,
  saveKeybinds,
  setRebinding,
  useKeybinds,
  useRebinding,
} from './voiceKeybinds';

/** "ControlRight" → "Ctrl Right" and the like: the key as someone would find it on a keyboard. */
export const pushToTalkKeyLabel = keyLabel;

export type PushToTalk = {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** The bound key (voiceKeybinds.ts). */
  key: string;
  keyLabel: string;
  /** True while waiting for the next keypress to bind — see `startRebind`. */
  rebinding: boolean;
  startRebind: () => void;
  cancelRebind: () => void;
};

/**
 * Push-to-talk as the call's mic button shows it: on or off, and which key. CallHotkeys is what
 * acts on it, for the whole call. While on, the mic is muted except while the key is held.
 */
export function usePushToTalk(): PushToTalk {
  const binds = useKeybinds();
  const rebinding = useRebinding() === 'pushToTalk';
  const bind = useCallback((binding: string) => saveKeybinds({ pushToTalkKey: binding }), []);
  useKeyCapture(rebinding, bind, { allowCombos: false });

  return {
    enabled: binds.pushToTalk,
    setEnabled: (enabled) => saveKeybinds({ pushToTalk: enabled }),
    key: binds.pushToTalkKey,
    keyLabel: keyLabel(binds.pushToTalkKey),
    rebinding,
    startRebind: () => setRebinding('pushToTalk'),
    cancelRebind: () => setRebinding(null),
  };
}

/**
 * While `active`, the next key (or mouse side button) is taken as a binding instead of doing what it
 * normally would, so binding a key that means something else in the app doesn't also do that.
 * Escape cancels. With `allowCombos`, a modifier held down waits for the key it goes with
 * (Ctrl+Shift+M); without, the first key pressed is the binding, Right Ctrl included.
 */
export function useKeyCapture(
  active: boolean,
  onBind: (binding: string) => void,
  { allowCombos }: { allowCombos: boolean }
): void {
  useEffect(() => {
    if (!active) return;
    const finish = (binding: string | null) => {
      setRebinding(null);
      if (binding) onBind(binding);
    };
    const onKeyDown = (evt: KeyboardEvent) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (evt.code === 'Escape') return finish(null);
      const binding = bindingFromEvent(evt);
      // A modifier on its own: in a combo, wait for the rest.
      if (allowCombos && binding === evt.code && /^(Control|Alt|Shift|Meta)/.test(evt.code)) return;
      finish(allowCombos ? binding : evt.code);
    };
    // A combo's modifier let go of without another key is the binding by itself.
    const onKeyUp = (evt: KeyboardEvent) => {
      if (allowCombos && /^(Control|Alt|Shift)/.test(evt.code)) finish(evt.code);
    };
    const onMouseDown = (evt: MouseEvent) => {
      const binding = mouseBinding(evt.button);
      if (!binding) return;
      evt.preventDefault();
      finish(binding);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousedown', onMouseDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('mousedown', onMouseDown, true);
    };
  }, [active, onBind, allowCombos]);
}
