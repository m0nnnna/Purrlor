import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Menu, MenuItem } from './Menu';

afterEach(cleanup);

function setup(onPick = vi.fn()) {
  render(
    <>
      <Menu label="Options" trigger="⋯" triggerClassName="trigger">
        <MenuItem onSelect={() => onPick('one')}>One</MenuItem>
        <MenuItem onSelect={() => onPick('two')}>Two</MenuItem>
        <MenuItem onSelect={() => onPick('three')}>Three</MenuItem>
      </Menu>
      <button>after</button>
    </>
  );
  return { trigger: screen.getByRole('button', { name: 'Options' }), onPick };
}

const item = (name: string) => screen.getByRole('menuitem', { name });

describe('Menu keyboard navigation', () => {
  it('opens on the first item with ↓ and on the last with ↑, and moves with the arrows, wrapping', () => {
    const { trigger } = setup();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(item('One')).toHaveFocus();

    fireEvent.keyDown(item('One'), { key: 'ArrowDown' });
    expect(item('Two')).toHaveFocus();
    fireEvent.keyDown(item('Two'), { key: 'End' });
    expect(item('Three')).toHaveFocus();
    fireEvent.keyDown(item('Three'), { key: 'ArrowDown' });
    expect(item('One')).toHaveFocus();
    fireEvent.keyDown(item('One'), { key: 'ArrowUp' });
    expect(item('Three')).toHaveFocus();
    fireEvent.keyDown(item('Three'), { key: 'Home' });
    expect(item('One')).toHaveFocus();

    cleanup();
    const again = setup();
    fireEvent.keyDown(again.trigger, { key: 'ArrowUp' });
    expect(item('Three')).toHaveFocus();
  });

  it('opens on the first item when the button is pressed with Enter or Space (a click with no pointer)', () => {
    const { trigger } = setup();
    fireEvent.click(trigger, { detail: 0 });
    expect(item('One')).toHaveFocus();
  });

  it('leaves focus on the button when opened with the mouse', () => {
    const { trigger } = setup();
    trigger.focus();
    fireEvent.click(trigger, { detail: 1 });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('Escape closes it and puts focus back on the button', () => {
    const { trigger } = setup();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('picking an item runs it, closes the menu and returns focus to the button', () => {
    const { trigger, onPick } = setup();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(item('Two'));
    expect(onPick).toHaveBeenCalledWith('two');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('Tab closes it without pulling focus back', () => {
    const { trigger } = setup();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(item('One'), { key: 'Tab' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps the items out of the tab order: the menu is one stop', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    expect(item('One')).toHaveAttribute('tabindex', '-1');
  });
});
