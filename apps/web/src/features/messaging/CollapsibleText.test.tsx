import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { CollapsibleText, isLongMessage } from './CollapsibleText';

afterEach(cleanup);

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('isLongMessage', () => {
  it('folds past 200 words or 15 lines, and nothing shorter', () => {
    expect(isLongMessage(words(200))).toBe(false);
    expect(isLongMessage(words(201))).toBe(true);
    expect(isLongMessage(Array(15).fill('a').join('\n'))).toBe(false);
    expect(isLongMessage(Array(16).fill('a').join('\n'))).toBe(true);
  });
});

describe('CollapsibleText', () => {
  it('leaves a short message as it is', () => {
    const { container } = render(
      <CollapsibleText className="text" text="hello">
        hello
      </CollapsibleText>
    );
    expect(container.querySelector('[data-nu-role="message-collapsible-toggle"]')).toBeNull();
    expect(container.querySelector('.text')?.textContent).toBe('hello');
  });

  it('folds a long one, and opens and closes it on request', () => {
    const text = words(500);
    const { container } = render(
      <CollapsibleText className="text" text={text}>
        {text}
      </CollapsibleText>
    );
    const body = container.querySelector('[data-nu-role="message-collapsible"]')!;
    const toggle = container.querySelector('[data-nu-role="message-collapsible-toggle"]') as HTMLButtonElement;
    expect(body.className).toContain('nu-collapsible--collapsed');
    expect(toggle.textContent).toBe('Show more (500 words)');
    fireEvent.click(toggle);
    expect(body.className).not.toContain('nu-collapsible--collapsed');
    expect(toggle.textContent).toBe('Show less');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(body.className).toContain('nu-collapsible--collapsed');
  });
});
