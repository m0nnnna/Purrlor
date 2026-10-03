import { useCallback, useContext, useEffect, useState, type FormEvent } from 'react';
import { useSetAtom } from 'jotai';
import { profileUserIdAtom } from '../../app/state/selection';
import { Avatar } from '../../components/Avatar';
import { MatrixClientContext, useMatrixClient } from '../../matrix/MatrixClientContext';
import {
  enforceGuestbookAutomod,
  fetchGuestbook,
  GUESTBOOK_ENTRY_MAX,
  guestbookSigningProblem,
  removeGuestbookEntry,
  signGuestbook,
  visibleGuestbookEntries,
  type GuestbookEntry,
} from '../../matrix/guestbook';
import { useFollows } from '../../matrix/hooks/useFollows';
import { useProfileBrief } from '../../matrix/hooks/useProfileBrief';
import type { PageBlock } from '../../matrix/profilePage';
import { fetchPublicPage, publicPagePath, type PublicPageAnswer } from '../../matrix/publicWeb';
import { handleFor } from '../../matrix/roles';
import { followsOf, verifiedFriends } from '../../matrix/topFriends';
import { formatPostTime } from '../feed/formatPostTime';
import { PageOwnerContext } from './PageOwnerContext';

type Block<T extends PageBlock['type']> = Extract<PageBlock, { type: T }>;


// --- Top 8 ------------------------------------------------------------------------------------

function FriendTile({ userId }: { userId: string }) {
  const brief = useProfileBrief(userId);
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  return (
    <button type="button" className="nu-profile-page__friend" data-nu-role="profile-page-friend" onClick={() => setProfileUserId(userId)}>
      <Avatar name={brief.name} mxcUrl={brief.avatarUrl ?? null} size={56} />
      <span className="nu-profile-page__friend-name">{brief.name}</span>
    </button>
  );
}

function SignedInFriends({ block, owner }: { block: Block<'friends'>; owner: string }) {
  const mx = useMatrixClient();
  const [shown, setShown] = useState<string[]>();
  const key = block.users.join(' ');
  useEffect(() => {
    let cancelled = false;
    void verifiedFriends(mx, owner, block.users).then((users) => {
      if (!cancelled) setShown(users);
    });
    return () => {
      cancelled = true;
    };
    // `key` stands for block.users: the list is rebuilt on every edit, the people in it aren't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mx, owner, key]);

  if (!shown) return <p className="nu-field__hint">Loading…</p>;
  if (shown.length === 0) return <p className="nu-field__hint">No friends to show yet.</p>;
  return (
    <div className="nu-profile-page__friends">
      {shown.map((userId) => (
        <FriendTile key={userId} userId={userId} />
      ))}
    </div>
  );
}

/** Signed out: only friends whose own pages are public, drawn from those pages' answers. */
function PublicFriends({ block }: { block: Block<'friends'> }) {
  const [answers, setAnswers] = useState<PublicPageAnswer[]>();
  const key = block.users.join(' ');
  useEffect(() => {
    let cancelled = false;
    void Promise.all(block.users.map((user) => fetchPublicPage(user))).then((results) => {
      if (cancelled) return;
      setAnswers(results.flatMap((result) => (result.status === 'ok' ? [result.value] : [])));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!answers || answers.length === 0) return null;
  return (
    <div className="nu-profile-page__friends">
      {answers.map((answer) => {
        const name = answer.displayName || handleFor(answer.userId);
        return (
          <a key={answer.userId} className="nu-profile-page__friend" href={publicPagePath(answer.userId)}>
            <Avatar name={name} mxcUrl={answer.avatarUrl ?? null} size={56} />
            <span className="nu-profile-page__friend-name">{name}</span>
          </a>
        );
      })}
    </div>
  );
}

export function FriendsBlock({ block }: { block: Block<'friends'> }) {
  const mx = useContext(MatrixClientContext);
  const owner = useContext(PageOwnerContext);
  if (!owner) return null;
  return (
    <>
      {mx ? <SignedInFriends block={block} owner={owner.userId} /> : <PublicFriends block={block} />}
    </>
  );
}

// --- Guestbook --------------------------------------------------------------------------------

/** Who the owner follows: your own list live, anyone else's from their profile room. */
function useOwnerFollows(owner: string, isMe: boolean): string[] | undefined {
  const mx = useMatrixClient();
  const mine = useFollows().users;
  const [theirs, setTheirs] = useState<string[]>();
  useEffect(() => {
    if (isMe) return undefined;
    let cancelled = false;
    void followsOf(mx, owner).then((list) => {
      if (!cancelled) setTheirs(list ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [mx, owner, isMe]);
  return isMe ? mine : theirs;
}

function EntryRow({ entry, canRemove, onRemove }: { entry: GuestbookEntry; canRemove: boolean; onRemove: () => void }) {
  const brief = useProfileBrief(entry.sender);
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  return (
    <li className="nu-profile-page__entry" data-nu-role="guestbook-entry">
      <button type="button" className="nu-profile-page__entry-avatar" aria-label={`Open ${brief.name}'s profile`} onClick={() => setProfileUserId(entry.sender)}>
        <Avatar name={brief.name} mxcUrl={brief.avatarUrl ?? null} size={32} />
      </button>
      <div className="nu-profile-page__entry-main">
        <div className="nu-profile-page__entry-meta">
          <strong>{brief.name}</strong>
          <time dateTime={new Date(entry.ts).toISOString()}>{formatPostTime(entry.ts)}</time>
          {canRemove && (
            <button type="button" className="nu-profile-page__entry-remove" data-nu-role="guestbook-remove" onClick={onRemove}>
              Remove
            </button>
          )}
        </div>
        {/* Plain text: never markup, so an entry can't be anything but words. */}
        <p className="nu-profile-page__entry-body">{entry.body}</p>
      </div>
    </li>
  );
}

function SignedInGuestbook({ block, owner }: { block: Block<'guestbook'>; owner: { userId: string; roomId?: string; isMe: boolean } }) {
  const mx = useMatrixClient();
  const me = mx.getUserId() ?? '';
  const ownerFollows = useOwnerFollows(owner.userId, owner.isMe);
  const [entries, setEntries] = useState<GuestbookEntry[]>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const { roomId } = owner;
  const rules = { who: block.who, slowmode: block.slowmode, blockedWords: block.blockedWords };
  const wordsKey = block.blockedWords.join('\n');

  const load = useCallback(async () => {
    if (!roomId) return;
    try {
      const loaded = await fetchGuestbook(mx, roomId);
      // The owner's client takes out entries with a blocked word, from the room as well as the page.
      if (owner.isMe && wordsKey) {
        const removed = new Set(await enforceGuestbookAutomod(mx, roomId, loaded, wordsKey.split('\n')));
        setEntries(loaded.filter((entry) => !removed.has(entry.eventId)));
      } else {
        setEntries(loaded);
      }
    } catch {
      setEntries((current) => current ?? []);
    }
  }, [mx, roomId, owner.isMe, wordsKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const problem = guestbookSigningProblem(me, owner.userId, rules, ownerFollows ?? [], entries ?? [], now);
  useEffect(() => {
    if (problem?.kind !== 'wait') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [problem?.kind]);

  if (!roomId) {
    return <p className="nu-field__hint">Entries show here once this page is published.</p>;
  }

  const shown = entries && ownerFollows ? visibleGuestbookEntries(entries, owner.userId, rules, ownerFollows) : undefined;

  const submit = async (evt: FormEvent) => {
    evt.preventDefault();
    if (busy || problem) return;
    setBusy(true);
    setError(undefined);
    try {
      await signGuestbook(mx, roomId, owner.userId, text, rules);
      setText('');
      setNow(Date.now());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t sign the guestbook');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: GuestbookEntry) => {
    setError(undefined);
    try {
      await removeGuestbookEntry(mx, roomId, entry.eventId);
      setEntries((current) => current?.filter((e) => e.eventId !== entry.eventId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t remove that entry');
    }
  };

  return (
    <>
      {problem?.kind === 'following' ? (
        <p className="nu-field__hint" data-nu-role="guestbook-following-only">
          Only people {handleFor(owner.userId)} follows can sign this guestbook.
        </p>
      ) : (
        <form className="nu-profile-page__sign" onSubmit={(evt) => void submit(evt)}>
          <textarea
            className="nu-field__input nu-field__textarea"
            rows={2}
            maxLength={GUESTBOOK_ENTRY_MAX}
            placeholder="Leave a message…"
            aria-label="Your message"
            value={text}
            onChange={(evt) => setText(evt.target.value)}
            data-nu-role="guestbook-text"
          />
          <div className="nu-profile-page__sign-row">
            <span className="nu-field__hint">
              {problem?.kind === 'wait'
                ? `Slowmode: you can sign again in ${Math.ceil(problem.ms / 1000)}s.`
                : block.slowmode > 0
                  ? `Slowmode: one entry every ${block.slowmode}s.`
                  : `${text.length} / ${GUESTBOOK_ENTRY_MAX}`}
            </span>
            <button type="submit" className="nu-button nu-button--primary" disabled={busy || !text.trim() || !!problem} data-nu-role="guestbook-sign">
              {busy ? 'Signing…' : 'Sign'}
            </button>
          </div>
        </form>
      )}
      {error && <p className="nu-field__error">{error}</p>}
      {!shown ? (
        <p className="nu-field__hint">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="nu-field__hint">No entries yet.</p>
      ) : (
        <ul className="nu-profile-page__entries">
          {shown.map((entry) => (
            <EntryRow key={entry.eventId} entry={entry} canRemove={owner.isMe || entry.sender === me} onRemove={() => void remove(entry)} />
          ))}
        </ul>
      )}
    </>
  );
}

export function GuestbookBlock({ block }: { block: Block<'guestbook'> }) {
  const mx = useContext(MatrixClientContext);
  const owner = useContext(PageOwnerContext);
  if (!owner) return null;
  return (
    <>
      {mx ? (
        <SignedInGuestbook block={block} owner={owner} />
      ) : (
        <p className="nu-field__hint" data-nu-role="guestbook-signed-out">
          Sign in to read and sign this guestbook.
        </p>
      )}
    </>
  );
}
