/**
 * What a custom theme (theme.ts) may not do: read the page.
 *
 * A theme is CSS, and people load themes other people made ("Load from file"). CSS can't run code,
 * but it can leak what's on the page: a rule like `input[value^="a"] { background: url(…/a) }`
 * fetches a different address for each letter typed, and the same trick on an attribute holding a
 * name or a link tells a server what you're looking at. The Content-Security-Policy
 * (deploy/security-headers.conf) already keeps a theme's @import and fonts to this site and Google
 * Fonts; background images may come from anywhere, since themes use them. So this takes out the
 * other half: every rule whose selector matches an attribute's value, unless the attribute is one
 * of the app's own presentational ones (`[data-nu-role="…"]`, the documented way to target parts
 * of the app, `[data-nu-icon="paw"]`, an ARIA state, a class).
 *
 * A theme that only targets the documented tokens and roles is untouched.
 */

/** Attributes whose values say how something looks or what part of the app it is, never what it holds. */
const PRESENTATIONAL =
  /^(data-nu-(?!event-id$|link$)[a-z-]+|class|id|role|type|dir|lang|aria-(selected|expanded|current|pressed|checked|disabled|hidden|busy|invalid|orientation|sort))$/i;

/** The attributes a selector compares a value against: `[name=…]`, `[name^=…]`, `[ns|name*=…]`… */
function attributesMatchedByValue(selector: string): string[] {
  const names: string[] = [];
  for (const match of selector.matchAll(/\[\s*(?:[\w*-]*\|(?!=))?([\w-]+)\s*[~|^$*]?=/g)) names.push(match[1]);
  return names;
}

/** Whether a selector compares the value of an attribute that might hold what's on the page. */
export function readsPage(selector: string): boolean {
  return attributesMatchedByValue(selector).some((name) => !PRESENTATIONAL.test(name));
}

type RuleList = { cssRules: CSSRuleList; deleteRule(index: number): void };

/** Takes out the rules that read the page, from `list` and any rules nested in it. */
function prune(list: RuleList, removed: string[]): void {
  for (let i = list.cssRules.length - 1; i >= 0; i--) {
    const rule = list.cssRules[i];
    const selector = (rule as CSSStyleRule).selectorText;
    if (typeof selector === 'string' && readsPage(selector)) {
      removed.unshift(selector.length > 120 ? `${selector.slice(0, 117)}…` : selector);
      list.deleteRule(i);
      continue;
    }
    // @media, @supports, @layer, @container, and nesting inside a style rule.
    const nested = rule as unknown as Partial<RuleList>;
    if (nested.cssRules && typeof nested.deleteRule === 'function') prune(nested as RuleList, removed);
  }
}

export type SanitizedTheme = {
  /** The theme to apply. */
  css: string;
  /** The selectors of the rules taken out, for telling the person why part of their theme did nothing. */
  removed: string[];
};

export function sanitizeThemeCss(css: string, doc: Document = document): SanitizedTheme {
  if (!css.trim()) return { css: '', removed: [] };
  // Parsed by the browser itself, in a stylesheet that applies to nothing (media "not all").
  const style = doc.createElement('style');
  style.media = 'not all';
  style.textContent = css;
  doc.head.appendChild(style);
  try {
    const sheet = style.sheet;
    if (!sheet) return { css: '', removed: [] };
    const removed: string[] = [];
    prune(sheet, removed);
    if (removed.length === 0) return { css, removed };
    return { css: Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n'), removed };
  } finally {
    style.remove();
  }
}
