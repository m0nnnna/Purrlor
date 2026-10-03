import { useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { RoomMember } from 'matrix-js-sdk';
import { Avatar } from '../../components/Avatar';
import { mentionCandidatesFor, mentionText, type MentionCandidate } from '../../matrix/messageFormatting';
import './Composer.css';

const MAX_MENTION_SUGGESTIONS = 8;

/** Someone who can be mentioned. */
export type MentionPerson = { userId: string; name: string; avatarUrl?: string | null };
/** "@" at the start or after whitespace, then whatever's been typed since, up to the cursor. */
const MENTION_TRIGGER_PATTERN = /(?:^|\s)@([^\s@]*)$/;

/**
 * `@name` autocomplete for any textarea: the chat composer, the post composer and comment boxes.
 *
 * A name picked from the dropdown, or anyone's name, handle or user ID typed out in full after an
 * "@", is a real mention (`candidates()`): buildMessageFormatting turns it into a pill and an
 * `m.mentions` entry, which is what notifies them. An "@word" that is nobody here stays text.
 */
export function useMentionAutocomplete({
  text,
  setText,
  textareaRef,
  people,
}: {
  text: string;
  setText: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  people: MentionPerson[];
}) {
  const [query, setQuery] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  // Display name -> user ID for every mention actually inserted via the dropdown this draft.
  const pickedRef = useRef<Map<string, string>>(new Map());

  const matches =
    query === null
      ? []
      : people.filter((m) => m.name.toLowerCase().includes(query.toLowerCase())).slice(0, MAX_MENTION_SUGGESTIONS);

  /** Call on every change, with the new value and where the cursor is. */
  const update = (value: string, cursor: number) => {
    const match = MENTION_TRIGGER_PATTERN.exec(value.slice(0, cursor));
    setQuery(match ? match[1] : null);
    setIndex(0);
  };

  const select = (member: MentionPerson) => {
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? text.length;
    const match = MENTION_TRIGGER_PATTERN.exec(text.slice(0, cursor));
    if (!match) return;
    // match[0] is "<ws-or-start>@query" — the '@' itself starts right before the query capture.
    const atIndex = cursor - match[1].length - 1;
    const before = text.slice(0, atIndex);
    const after = text.slice(cursor);
    const inserted = `${mentionText(member.name)} `;
    pickedRef.current.set(member.name, member.userId);
    setText(`${before}${inserted}${after}`);
    setQuery(null);
    requestAnimationFrame(() => {
      const pos = before.length + inserted.length;
      textarea?.focus();
      textarea?.setSelectionRange(pos, pos);
    });
  };

  /** Arrow keys, Enter/Tab and Escape while the dropdown is open. True when it handled the key. */
  const handleKeyDown = (evt: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (query === null || matches.length === 0) return false;
    if (evt.key === 'ArrowDown') {
      evt.preventDefault();
      setIndex((i) => (i + 1) % matches.length);
      return true;
    }
    if (evt.key === 'ArrowUp') {
      evt.preventDefault();
      setIndex((i) => (i - 1 + matches.length) % matches.length);
      return true;
    }
    if (evt.key === 'Enter' || evt.key === 'Tab') {
      evt.preventDefault();
      select(matches[index]);
      return true;
    }
    if (evt.key === 'Escape') {
      evt.preventDefault();
      setQuery(null);
      return true;
    }
    return false;
  };

  /** Who the draft can mention: names picked from the dropdown first (they decide a name two
   *  people share), then everyone here by name, handle or full user ID, typed out in full. */
  const candidates = (): MentionCandidate[] => [
    ...[...pickedRef.current.entries()].map(([displayName, userId]) => ({ displayName, userId })),
    ...mentionCandidatesFor(people),
  ];

  /** Hides the dropdown, keeping what's been picked (a failed send restores the draft with them). */
  const close = () => setQuery(null);

  /** After a successful send: the next draft starts with no mentions picked. */
  const reset = () => {
    pickedRef.current.clear();
    setQuery(null);
  };

  const dropdown =
    query !== null && matches.length > 0 ? (
      <div className="nu-composer__mentions" data-nu-role="composer-mentions">
        {matches.map((member, i) => (
          <button
            key={member.userId}
            type="button"
            className={i === index ? 'nu-composer__mention-item nu-composer__mention-item--active' : 'nu-composer__mention-item'}
            data-nu-role="composer-mention-item"
            onMouseDown={(evt) => {
              evt.preventDefault(); // keep textarea focus so select can read its selection
              select(member);
            }}
          >
            <Avatar name={member.name} mxcUrl={member.avatarUrl ?? null} size={18} />
            <span>{member.name}</span>
          </button>
        ))}
      </div>
    ) : null;

  return { update, handleKeyDown, candidates, close, reset, dropdown };
}

/** Room members as mentionable people. */
export function membersAsPeople(members: RoomMember[]): MentionPerson[] {
  return members.map((member) => ({ userId: member.userId, name: member.name, avatarUrl: member.getMxcAvatarUrl() }));
}

