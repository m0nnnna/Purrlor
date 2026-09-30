import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import './Menu.css';

/** `restoreFocus`: put focus back on the trigger — after picking an item or Escape, not after a click elsewhere. */
const CloseContext = createContext<(restoreFocus?: boolean) => void>(() => undefined);

const ITEMS = '[role="menuitem"]:not([disabled])';

/**
 * A button that opens a short list of actions below it — the ⋯ on a post, say. Closes on picking
 * an item, clicking anywhere else, or Escape.
 *
 * From the keyboard: Enter, Space or ↓ on the trigger opens it on the first item (↑ on the last);
 * ↑ and ↓ then move between items, wrapping, Home and End jump to the ends, Enter or Space picks,
 * Escape closes, and focus returns to the trigger after picking or Escape. Tab just moves on.
 */
export function Menu({
  label,
  trigger,
  triggerClassName,
  role,
  align = 'start',
  dropUp = false,
  children,
}: {
  /** Accessible name for the trigger, also its tooltip. */
  label: string;
  /** What the trigger shows. */
  trigger: ReactNode;
  triggerClassName: string;
  role?: string;
  align?: 'start' | 'end';
  /** Opens above the trigger instead of below — for a trigger that sits at the bottom of the
   *  viewport (the composer's attach button), where the default downward list would clip. */
  dropUp?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Which item the menu should focus when it opens: set by a key on the trigger, not by a click,
  // where moving focus off the button the mouse just used would only be a surprise.
  const focusOnOpen = useRef<'first' | 'last' | null>(null);

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    const items = listRef.current?.querySelectorAll<HTMLElement>(ITEMS);
    if (items?.length) (focusOnOpen.current === 'last' ? items[items.length - 1] : focusOnOpen.current === 'first' ? items[0] : undefined)?.focus();
    focusOnOpen.current = null;

    const onPointer = (evt: PointerEvent) => {
      if (!rootRef.current?.contains(evt.target as Node)) setOpen(false);
    };
    const onKey = (evt: globalThis.KeyboardEvent) => {
      if (evt.key === 'Escape') close(true);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onTriggerKeyDown = (evt: KeyboardEvent<HTMLButtonElement>) => {
    if (evt.key !== 'ArrowDown' && evt.key !== 'ArrowUp') return;
    evt.preventDefault();
    focusOnOpen.current = evt.key === 'ArrowUp' ? 'last' : 'first';
    if (open) {
      // Already open: just move into the list.
      const items = listRef.current?.querySelectorAll<HTMLElement>(ITEMS);
      if (items?.length) (evt.key === 'ArrowUp' ? items[items.length - 1] : items[0]).focus();
      focusOnOpen.current = null;
    } else {
      setOpen(true);
    }
  };

  const onListKeyDown = (evt: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next: number | undefined;
    if (evt.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (evt.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (evt.key === 'Home') next = 0;
    else if (evt.key === 'End') next = items.length - 1;
    else if (evt.key === 'Tab') setOpen(false); // focus moves on by itself
    if (next === undefined) return;
    evt.preventDefault();
    items[next].focus();
  };

  return (
    <span className="nu-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        data-nu-role={role}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(evt) => {
          // Enter or Space on the button arrives as a click with no pointer (detail 0): open on the first item.
          if (!open && evt.detail === 0) focusOnOpen.current = 'first';
          setOpen((o) => !o);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {trigger}
      </button>
      {open && (
        <CloseContext.Provider value={close}>
          <div
            ref={listRef}
            className={`nu-menu__list nu-menu__list--${align}${dropUp ? ' nu-menu__list--up' : ''}`}
            role="menu"
            data-nu-role={role && `${role}-list`}
            onKeyDown={onListKeyDown}
          >
            {children}
          </div>
        </CloseContext.Provider>
      )}
    </span>
  );
}

export function MenuItem({
  icon,
  danger,
  role,
  onSelect,
  children,
}: {
  icon?: IconName;
  danger?: boolean;
  role?: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  const close = useContext(CloseContext);
  return (
    <button
      type="button"
      role="menuitem"
      // Reached with the arrow keys, not Tab: a menu is one stop in the page's tab order.
      tabIndex={-1}
      className={danger ? 'nu-menu__item nu-menu__item--danger' : 'nu-menu__item'}
      data-nu-role={role}
      onClick={() => {
        // Focus goes back to the trigger first, so an item that opens a dialog hands it on from there.
        close(true);
        onSelect();
      }}
    >
      {icon && <Icon name={icon} size={15} />}
      {children}
    </button>
  );
}
