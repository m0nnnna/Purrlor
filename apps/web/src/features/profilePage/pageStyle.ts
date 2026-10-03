import { useEffect, type CSSProperties } from 'react';
import { readableTextOn, type PageFont, type PageStyle } from '../../matrix/profilePage';

/**
 * Turns a page's checked style (matrix/profilePage.ts) into CSS custom properties on the page's
 * own container; ProfilePage.css does the styling with them. Every value here is one the parser
 * already limited to a colour, a number or a name from a fixed list, so no string a person typed
 * reaches the stylesheet.
 */

type FontInfo = { label: string; stack: string; /** Google Fonts family to load, unless the app already does. */ load?: string };

export const FONTS: Record<PageFont, FontInfo> = {
  figtree: { label: 'Figtree', stack: "'Figtree', system-ui, sans-serif" },
  display: { label: 'Dela Gothic', stack: "'Dela Gothic One', 'Figtree', sans-serif" },
  pixel: { label: 'Pixel', stack: "'Pixelify Sans', monospace", load: 'Pixelify+Sans:wght@400;700' },
  handwriting: { label: 'Handwriting', stack: "'Caveat', cursive", load: 'Caveat:wght@400;700' },
  serif: { label: 'Serif', stack: "'Lora', Georgia, serif", load: 'Lora:ital,wght@0,400;0,700;1,400' },
  mono: { label: 'Mono', stack: "'JetBrains Mono', ui-monospace, monospace" },
  rounded: { label: 'Rounded', stack: "'Nunito', 'Figtree', sans-serif", load: 'Nunito:wght@400;700;800' },
  typewriter: { label: 'Typewriter', stack: "'Special Elite', 'Courier New', monospace", load: 'Special+Elite' },
  comic: { label: 'Comic', stack: "'Comic Neue', 'Comic Sans MS', cursive", load: 'Comic+Neue:wght@400;700' },
  condensed: { label: 'Condensed', stack: "'Bebas Neue', 'Figtree', sans-serif", load: 'Bebas+Neue' },
};

const loadedFonts = new Set<string>();

/** Loads the page's fonts from Google Fonts, where the app's own fonts already come from. */
export function usePageFonts(style: PageStyle | undefined): void {
  const heading = style?.fonts.heading;
  const body = style?.fonts.body;
  useEffect(() => {
    for (const font of [heading, body]) {
      const family = font && FONTS[font].load;
      if (!family || loadedFonts.has(family)) continue;
      loadedFonts.add(family);
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
      document.head.appendChild(link);
    }
  }, [heading, body]);
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** A URL the app built itself (useMediaUrl, from a checked mxc:// URL), quoted for `url()`. */
function cssUrl(src: string): string {
  return `url("${src.replace(/["\\\n\r]/g, (char) => encodeURIComponent(char))}")`;
}

/**
 * The container's style. `backgroundSrc` is the background image's loaded URL, when the page
 * has one (it comes from the homeserver, through useMediaUrl).
 */
export function pageStyleVars(style: PageStyle, backgroundSrc: string | null): CSSProperties {
  const { colors, background, border, borderColor } = style;
  const vars: Record<string, string> = {
    '--page-bg': colors.bg,
    '--page-text': colors.text,
    '--page-accent': colors.accent,
    '--page-link': colors.link,
    '--page-block': rgba(colors.block, style.blockOpacity),
    // The posts column draws its cards in the block colour at full strength, so a post stays
    // readable over a background image whatever the page's block opacity.
    '--page-block-solid': colors.block,
    // A button's label on the accent: black or white, whichever reads.
    '--page-on-accent': readableTextOn(colors.accent),
    '--page-corners': `${style.corners}px`,
    '--page-border':
      border === 'none'
        ? 'none'
        : `${border === 'double' ? 3 : border === 'glow' ? 1 : 2}px ${border === 'glow' ? 'solid' : border} ${borderColor}`,
    '--page-shadow': border === 'glow' ? `0 0 14px ${rgba(borderColor, 0.75)}` : 'none',
    '--page-heading-font': FONTS[style.fonts.heading].stack,
    '--page-body-font': FONTS[style.fonts.body].stack,
  };
  const css: CSSProperties = { ...(vars as CSSProperties), backgroundColor: colors.bg };
  if (background.kind === 'gradient') {
    css.backgroundImage = `linear-gradient(${background.angle}deg, ${background.from}, ${background.to})`;
    css.backgroundAttachment = 'local';
  } else if (background.kind === 'image' && backgroundSrc) {
    css.backgroundImage = cssUrl(backgroundSrc);
    if (background.fit === 'tile') {
      css.backgroundRepeat = 'repeat';
      css.backgroundAttachment = 'local';
    } else {
      css.backgroundSize = 'cover';
      css.backgroundPosition = 'center';
      css.backgroundRepeat = 'no-repeat';
      css.backgroundAttachment = background.fit === 'fixed' ? 'fixed' : 'local';
    }
  }
  return css;
}

/** The host name a link goes to, shown under every link so nobody's surprised where it leads. */
export function linkDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
