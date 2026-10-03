import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'jotai';
import { ReactionBar, whoReacted } from './ReactionBar';
import type { ReactionGroup } from '../../matrix/hooks/useReactions';

vi.mock('./EmoteImage', () => ({ EmoteImage: ({ shortcode }: { shortcode: string }) => <img alt={`:${shortcode}:`} /> }));
vi.mock('../../components/Avatar', () => ({ Avatar: () => null }));

const names: Record<string, string> = { '@me:x': 'Me', '@luna:x': 'Luna', '@bo:x': 'Bo', '@cy:x': 'Cy', '@di:x': 'Di', '@ed:x': 'Ed' };
const nameOf = (userId: string) => names[userId] ?? userId;

describe('whoReacted', () => {
  it('names up to three people, you first, then counts the rest', () => {
    expect(whoReacted(['@luna:x'], '@me:x', nameOf, '🎉')).toBe('Luna reacted with 🎉');
    expect(whoReacted(['@luna:x', '@me:x'], '@me:x', nameOf, '🎉')).toBe('You and Luna reacted with 🎉');
    expect(whoReacted(['@luna:x', '@bo:x', '@cy:x'], '@me:x', nameOf, '🎉')).toBe('Luna, Bo and Cy reacted with 🎉');
    expect(whoReacted(['@luna:x', '@bo:x', '@cy:x', '@di:x'], '@me:x', nameOf, ':cat:')).toBe('Luna, Bo, Cy and 1 other reacted with :cat:');
    expect(whoReacted(['@luna:x', '@bo:x', '@cy:x', '@di:x', '@ed:x'], null, nameOf, '🎉')).toBe('Luna, Bo, Cy and 2 others reacted with 🎉');
  });
});

describe('ReactionBar', () => {
  const groups: ReactionGroup[] = [
    { key: '🎉', count: 2, hasOwnReaction: true, senders: ['@luna:x', '@me:x'] },
    { key: 'mxc://x/cat', shortcode: 'cat', count: 1, hasOwnReaction: false, senders: ['@bo:x'] },
  ];

  it('says who reacted on each pill, and lists everyone by reaction', () => {
    render(
      <Provider>
        <ReactionBar groups={groups} onToggle={() => undefined} myUserId="@me:x" nameOf={nameOf} avatarOf={() => null} />
      </Provider>
    );
    expect(screen.getByTitle('You and Luna reacted with 🎉')).toBeInTheDocument();
    expect(screen.getByTitle('Bo reacted with :cat:')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'See who reacted' }));
    const list = screen.getByRole('heading', { name: /Reactions/ }).closest('[data-nu-role="modal"]') ?? document.body;
    const people = Array.from(list.querySelectorAll('[data-nu-role="reactions-list-person"]'), (el) => el.textContent);
    expect(people).toEqual(['Luna', 'Me', 'Bo']);
  });
});
