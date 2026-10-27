import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { combineHandlers, LONG_PRESS_MS, useLongPress } from './useLongPress';

function Pressable({ onLongPress, onClick }: { onLongPress?: () => void; onClick?: () => void }) {
  const handlers = useLongPress(onLongPress);
  return (
    <div data-testid="target" onClick={onClick} {...handlers}>
      hold me
    </div>
  );
}

const at = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });

describe('useLongPress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('fires once a finger has rested for the hold time', () => {
    const onLongPress = vi.fn();
    render(<Pressable onLongPress={onLongPress} />);
    fireEvent.touchStart(screen.getByTestId('target'), at(50, 50));
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a tap', () => {
    const onLongPress = vi.fn();
    render(<Pressable onLongPress={onLongPress} />);
    const target = screen.getByTestId('target');
    fireEvent.touchStart(target, at(50, 50));
    fireEvent.touchEnd(target);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('gives way to a scroll or a swipe', () => {
    const onLongPress = vi.fn();
    render(<Pressable onLongPress={onLongPress} />);
    const target = screen.getByTestId('target');
    fireEvent.touchStart(target, at(50, 50));
    fireEvent.touchMove(target, at(50, 70));
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('keeps a small wobble a press', () => {
    const onLongPress = vi.fn();
    render(<Pressable onLongPress={onLongPress} />);
    const target = screen.getByTestId('target');
    fireEvent.touchStart(target, at(50, 50));
    fireEvent.touchMove(target, at(54, 47));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('swallows the lift after a press that fired, but not after a tap', () => {
    render(<Pressable onLongPress={() => {}} />);
    const target = screen.getByTestId('target');
    fireEvent.touchStart(target, at(50, 50));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fireEvent.touchEnd(target)).toBe(false);

    fireEvent.touchStart(target, at(50, 50));
    expect(fireEvent.touchEnd(target)).toBe(true);
  });

  it('keeps the browser’s own long-press menu away', () => {
    render(<Pressable onLongPress={() => {}} />);
    expect(fireEvent.contextMenu(screen.getByTestId('target'))).toBe(false);
  });

  it('adds no handlers when there is nothing to open', () => {
    render(<Pressable />);
    expect(fireEvent.contextMenu(screen.getByTestId('target'))).toBe(true);
  });
});

describe('combineHandlers', () => {
  it('calls each gesture’s handler for the same event, in order', () => {
    const calls: string[] = [];
    const combined = combineHandlers({ onTouchStart: () => calls.push('swipe') }, {}, { onTouchStart: () => calls.push('press'), onTouchEnd: () => calls.push('lift') });
    combined.onTouchStart?.({} as never);
    combined.onTouchEnd?.({} as never);
    expect(calls).toEqual(['swipe', 'press', 'lift']);
    expect(combined.onTouchMove).toBeUndefined();
  });
});
