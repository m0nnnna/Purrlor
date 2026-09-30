import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { Emote } from '../../matrix/emotes';
import { renderMessageText } from './renderMessageText';

// EmoteImage's only client dependency, faked so emotes render as plain <img>s here.
vi.mock('../../matrix/hooks/useMediaUrl', () => ({ useMediaUrl: (mxcUrl: string) => `blob:${mxcUrl}` }));

const emotes: Emote[] = [
  { shortcode: 'cat', mxcUrl: 'mxc://x/cat' },
  { shortcode: 'dog', mxcUrl: 'mxc://x/dog' },
];

function emoteClasses(text: string): string[] {
  const { container } = render(<div>{renderMessageText(text, emotes)}</div>);
  return Array.from(container.querySelectorAll('[data-nu-role="emote"]'), (img) => img.className);
}

describe('emote sizes in a message', () => {
  it('shows emotes big when the message is nothing but emotes', () => {
    expect(emoteClasses(':cat:')).toEqual(['nu-emote nu-emote--jumbo']);
    expect(emoteClasses(' :cat: :dog:  ')).toEqual(['nu-emote nu-emote--jumbo', 'nu-emote nu-emote--jumbo']);
  });

  it('keeps them text-sized beside words', () => {
    expect(emoteClasses('too smol :cat:')).toEqual(['nu-emote nu-emote--message']);
  });

  it('keeps them text-sized beside an unknown shortcode or other formatting', () => {
    expect(emoteClasses(':cat: :nope:')).toEqual(['nu-emote nu-emote--message']);
    expect(emoteClasses(':cat: **hi**')).toEqual(['nu-emote nu-emote--message']);
  });

  it('keeps a long run of emotes text-sized', () => {
    expect(new Set(emoteClasses(':cat:'.repeat(28)))).toEqual(new Set(['nu-emote nu-emote--message']));
  });
});
