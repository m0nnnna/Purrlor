import { useState } from 'react';
import { useSetAtom } from 'jotai';
import type { ReactionGroup } from '../../matrix/hooks/useReactions';
import { profileUserIdAtom } from '../../app/state/selection';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { EmoteImage } from './EmoteImage';
import './ReactionBar.css';

/** How a reaction is named in words: the emoji, or a custom emote's `:shortcode:`. */
function reactionLabel(group: ReactionGroup): string {
  return group.key.startsWith('mxc://') ? `:${group.shortcode ?? 'emote'}:` : group.key;
}

/**
 * "You, Luna and 3 others reacted with 🎉": who's behind a pill, for its tooltip and for screen
 * readers. You first, then in the order people reacted; past three names, a count. Pure.
 */
export function whoReacted(senders: string[], myUserId: string | null, nameOf: (userId: string) => string, label: string): string {
  const ordered = myUserId && senders.includes(myUserId) ? [myUserId, ...senders.filter((s) => s !== myUserId)] : senders;
  const names = ordered.map((userId) => (userId === myUserId ? 'You' : nameOf(userId)));
  let who: string;
  if (names.length <= 1) who = names[0] ?? 'Nobody';
  else if (names.length <= 3) who = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  else {
    const others = names.length - 3;
    who = `${names.slice(0, 3).join(', ')} and ${others} ${others === 1 ? 'other' : 'others'}`;
  }
  return `${who} reacted with ${label}`;
}

function ReactionKey({ group }: { group: ReactionGroup }) {
  return group.key.startsWith('mxc://') ? (
    <EmoteImage shortcode={group.shortcode ?? 'emote'} mxcUrl={group.key} />
  ) : (
    <span className="nu-reaction-pill__key">{group.key}</span>
  );
}

/** Everyone who reacted, grouped by reaction. Tapping someone opens their profile. */
function ReactionsModal({
  groups,
  nameOf,
  avatarOf,
  onClose,
}: {
  groups: ReactionGroup[];
  nameOf: (userId: string) => string;
  avatarOf: (userId: string) => string | null | undefined;
  onClose: () => void;
}) {
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  return (
    <Modal title="Reactions" onClose={onClose}>
      <div className="nu-reactions-list" data-nu-role="reactions-list">
        {groups.map((group) => (
          <section key={group.key} className="nu-reactions-list__group" data-nu-role="reactions-list-group">
            <h3 className="nu-reactions-list__heading" title={reactionLabel(group)}>
              <ReactionKey group={group} /> <span className="nu-reactions-list__count">{group.senders.length}</span>
            </h3>
            <ul className="nu-reactions-list__people">
              {group.senders.map((userId) => (
                <li key={userId}>
                  <button
                    type="button"
                    className="nu-reactions-list__person"
                    data-nu-role="reactions-list-person"
                    onClick={() => {
                      onClose();
                      setProfileUserId(userId);
                    }}
                  >
                    <Avatar name={nameOf(userId)} mxcUrl={avatarOf(userId) ?? null} size={28} />
                    <span>{nameOf(userId)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}

/** The pill row for a message's existing reactions — click a pill to toggle your own. Adding a
 *  *new* reaction type goes through the hover-revealed "React" button (ReactionPicker) instead,
 *  not through this row. A group whose `key` is an `mxc://` URL is a custom emote reaction
 *  (ReactionPicker.tsx) rather than plain Unicode — rendered as the image itself (EmoteImage,
 *  which already resolves authenticated media the same way the composer's own emotes do).
 *
 *  Each pill says who reacted (its tooltip and accessible name), and the last button lists
 *  everyone by reaction, for touch screens, where there's no hovering. */
export function ReactionBar({
  groups,
  onToggle,
  myUserId,
  nameOf,
  avatarOf,
}: {
  groups: ReactionGroup[];
  onToggle: (group: ReactionGroup) => void;
  myUserId: string | null;
  nameOf: (userId: string) => string;
  avatarOf: (userId: string) => string | null | undefined;
}) {
  const [showWho, setShowWho] = useState(false);
  if (groups.length === 0) return null;

  return (
    <div className="nu-reaction-bar" data-nu-role="reaction-bar">
      {groups.map((group) => {
        const who = whoReacted(group.senders, myUserId, nameOf, reactionLabel(group));
        return (
          <button
            key={group.key}
            type="button"
            className={group.hasOwnReaction ? 'nu-reaction-pill nu-reaction-pill--own' : 'nu-reaction-pill'}
            data-nu-role="reaction-pill"
            title={who}
            aria-label={`${who}. ${group.hasOwnReaction ? 'Remove your reaction' : 'React too'}`}
            aria-pressed={group.hasOwnReaction}
            onClick={() => onToggle(group)}
          >
            <ReactionKey group={group} />
            <span className="nu-reaction-pill__count">{group.count}</span>
          </button>
        );
      })}
      <button
        type="button"
        className="nu-reaction-pill nu-reaction-pill--who"
        data-nu-role="reaction-who"
        title="See who reacted"
        aria-label="See who reacted"
        onClick={() => setShowWho(true)}
      >
        <Icon name="users" size={14} />
      </button>
      {showWho && <ReactionsModal groups={groups} nameOf={nameOf} avatarOf={avatarOf} onClose={() => setShowWho(false)} />}
    </div>
  );
}
