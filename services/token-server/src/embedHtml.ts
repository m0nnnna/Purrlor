/**
 * Reads what a page says about itself from its <head>: OpenGraph (`og:`), Twitter card
 * (`twitter:`) and the plain <title>, description and theme-color. Pages are untrusted text, so
 * this is a small, forgiving scanner rather than a parser, and only ever returns plain strings.
 */

export type PageMeta = {
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  imageType?: string;
  video?: string;
  videoType?: string;
  type?: string;
  color?: string;
  /** The page's canonical address (`og:url`). */
  url?: string;
  /** `og:restrictions:age`, `rating` adult, and the like. */
  adult?: boolean;
};

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}

/** Text from HTML: tags gone, entities decoded, whitespace collapsed. */
export function plainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/[ \t\f\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function attributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const pattern = /([^\s=/<>"']+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  const inner = tag.replace(/^<\s*\w+/, '').replace(/\/?>$/, '');
  while ((match = pattern.exec(inner))) {
    attrs.set(match[1].toLowerCase(), decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attrs;
}

/** The charset a page declares in a <meta> tag, for when the response didn't say. */
export function declaredCharset(head: string): string | undefined {
  return /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
}

/** Decodes a page's bytes with the charset its response or its <meta> gives, else UTF-8. */
export function decodePage(body: Buffer, contentType: string): string {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType)?.[1];
  const charset = fromHeader ?? declaredCharset(body.subarray(0, 2048).toString('latin1')) ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

function clean(value: string | undefined, max: number): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

export function readPageMeta(html: string): PageMeta {
  // Only the head matters; a page without a </head> gets its first part.
  const head = html.slice(0, Math.max(0, html.search(/<\/head>/i)) || 300_000);
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    const key = (attrs.get('property') ?? attrs.get('name') ?? attrs.get('itemprop'))?.toLowerCase();
    const content = attrs.get('content');
    // The first of each wins: og:image's first is the page's main picture.
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const get = (...keys: string[]) => keys.map((key) => meta.get(key)).find((value) => value && value.trim());
  const color = get('theme-color');
  const adult = get('og:restrictions:age');
  const rating = get('rating');
  return {
    title: clean(get('og:title', 'twitter:title') ?? (title ? decodeEntities(title) : undefined), 256),
    description: clean(get('og:description', 'twitter:description', 'description'), 1000),
    siteName: clean(get('og:site_name', 'application-name'), 64),
    image: get('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'),
    imageType: get('og:image:type'),
    video: get('og:video:secure_url', 'og:video', 'og:video:url'),
    videoType: get('og:video:type'),
    type: get('og:type'),
    color: color && /^#[0-9a-f]{6}$/i.test(color.trim()) ? color.trim().toLowerCase() : undefined,
    url: get('og:url'),
    adult: (adult !== undefined && /\d/.test(adult) && parseInt(adult, 10) >= 18) || (rating !== undefined && /adult|mature|rta-5042/i.test(rating)),
  };
}
