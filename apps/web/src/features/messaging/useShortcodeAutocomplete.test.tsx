import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { Emote } from '../../matrix/emotes';
import { useShortcodeAutocomplete } from './useShortcodeAutocomplete';

// EmoteImage needs a MatrixClient (useMediaUrl -> useMatrixClient) just to render a plain <img>,
// the same reason renderMessageText.test.tsx avoids exercising it directly — stubbed here so the
// dropdown itself (order/selection/keyboard behavior, the thing actually under test) can render
// without a real client.
vi.mock('./EmoteImage', () => ({
  EmoteImage: ({ shortcode }: { shortcode: string }) => <>{`:${shortcode}:`}</>,
}));

const EMOTES: Emote[] = [
  { shortcode: 'cat', mxcUrl: 'mxc://example.org/cat' },
  { shortcode: 'catjam', mxcUrl: 'mxc://example.org/catjam' },
];

function Harness({ emotes = EMOTES }: { emotes?: Emote[] }) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const ac = useShortcodeAutocomplete({ text, setText, textareaRef, emotes });
  return (
    <div>
      <textarea
        ref={textareaRef}
        data-testid="composer-input"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          ac.update(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={(e) => ac.handleKeyDown(e)}
      />
      {ac.dropdown}
    </div>
  );
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

describe('useShortcodeAutocomplete', () => {
  it('shows nothing before a colon is typed', () => {
    const { container } = render(<Harness />);
    type(container.querySelector('textarea')!, 'just typing along');
    expect(container.querySelector('[data-nu-role="composer-shortcodes"]')).toBeNull();
  });

  it('shows nothing for a colon with fewer than two characters after it', () => {
    const { container } = render(<Harness />);
    type(container.querySelector('textarea')!, 'hi :c');
    expect(container.querySelector('[data-nu-role="composer-shortcodes"]')).toBeNull();
  });

  it('suggests a matching custom emote once at least two characters follow the colon', () => {
    const { container } = render(<Harness />);
    type(container.querySelector('textarea')!, 'hi :ca');
    const items = container.querySelectorAll('[data-nu-role="composer-shortcode-item"]');
    expect(items.length).toBeGreaterThan(0);
    expect(container.querySelector('[data-nu-role="composer-shortcodes"]')).toHaveTextContent(':cat:');
    expect(container.querySelector('[data-nu-role="composer-shortcodes"]')).toHaveTextContent(':catjam:');
  });

  it('falls back to matching Unicode emoji by name/slug when no custom emote matches', () => {
    const { container } = render(<Harness />);
    type(container.querySelector('textarea')!, 'so :fire');
    const dropdown = container.querySelector('[data-nu-role="composer-shortcodes"]');
    expect(dropdown).toHaveTextContent(':fire:');
  });

  it('hides again once the query no longer matches a colon at the cursor', () => {
    const { container } = render(<Harness />);
    const input = container.querySelector('textarea')!;
    type(input, 'hi :ca');
    expect(container.querySelector('[data-nu-role="composer-shortcodes"]')).not.toBeNull();
    type(input, 'hi :ca ');
    expect(container.querySelector('[data-nu-role="composer-shortcodes"]')).toBeNull();
  });

  it('clicking a suggestion replaces the typed :query with :shortcode: and a trailing space', () => {
    const { container } = render(<Harness />);
    const input = container.querySelector('textarea')! as HTMLTextAreaElement;
    type(input, 'hi :ca');
    const catItem = Array.from(container.querySelectorAll('[data-nu-role="composer-shortcode-item"]')).find((el) =>
      el.textContent?.includes(':cat:')
    )!;
    fireEvent.mouseDown(catItem);
    expect(input.value).toBe('hi :cat: ');
    expect(container.querySelector('[data-nu-role="composer-shortcodes"]')).toBeNull();
  });

  it('Enter picks the highlighted suggestion, and ArrowDown moves the highlight first', () => {
    const { container } = render(<Harness />);
    const input = container.querySelector('textarea')! as HTMLTextAreaElement;
    type(input, 'hi :ca');
    const items = () => Array.from(container.querySelectorAll('[data-nu-role="composer-shortcode-item"]'));
    expect(items()[0]).toHaveClass('nu-composer__mention-item--active');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(items()[1]).toHaveClass('nu-composer__mention-item--active');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('hi :catjam: ');
  });

  it('Escape dismisses the dropdown without changing the text', () => {
    const { container } = render(<Harness />);
    const input = container.querySelector('textarea')! as HTMLTextAreaElement;
    type(input, 'hi :ca');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(container.querySelector('[data-nu-role="composer-shortcodes"]')).toBeNull();
    expect(input.value).toBe('hi :ca');
  });
});
