/**
 * Custom-theme loading — the "Loading a theme" mechanism docs/theming.md described ahead of
 * time (Phase 4, "not implemented yet"). A saved theme is a single raw CSS string, stored
 * client-side (localStorage — this is a self-authored, single-user override, not something
 * shared between accounts) and injected as one `<style id="nu-theme-override">` tag appended
 * after the base stylesheet; cascade order does the overriding, no `!important` needed anywhere
 * as long as the theme's own selectors are at least as specific as the base styles; targeting
 * the documented token variables (`--nu-color-*` etc.) on `:root` needs no specificity fight at
 * all. See AppearanceSettings.tsx for the editor UI.
 */
import { sanitizeThemeCss } from './themeSanitize';

const STORAGE_KEY = 'nekous_custom_theme_css';
const STYLE_ELEMENT_ID = 'nu-theme-override';

function getStyleElement(): HTMLStyleElement {
  let el = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ELEMENT_ID;
    document.head.appendChild(el);
  }
  return el;
}

export function getStoredThemeCss(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Applies the theme without the rules that could read the page (themeSanitize.ts), and says which those were. */
function applyThemeCss(css: string): string[] {
  const { css: safe, removed } = sanitizeThemeCss(css);
  getStyleElement().textContent = safe;
  return removed;
}

/**
 * Saves (or, given an empty string, clears) the custom theme and applies it immediately. Returns the
 * selectors of any rules left out because they could read what's on the page. The theme is saved as
 * written, so editing it later shows what the person wrote.
 */
export function saveThemeCss(css: string): string[] {
  try {
    if (css) {
      localStorage.setItem(STORAGE_KEY, css);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Best-effort: a full/blocked localStorage just means the override won't survive a reload,
    // not that applying it right now should fail too.
  }
  return applyThemeCss(css);
}

/** Call once at boot (main.tsx) so a previously saved theme survives a reload — before React
 *  renders anything, so there's no flash of the default look first. */
export function applyStoredThemeOnLoad(): void {
  const css = getStoredThemeCss();
  if (css) applyThemeCss(css);
}
