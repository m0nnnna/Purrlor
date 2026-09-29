import type { ReactionGroup } from '../../matrix/hooks/useReactions';
import { EmoteImage } from './EmoteImage';
import './ReactionBar.css';

/** The pill row for a message's existing reactions — click a pill to toggle your own. Adding a
 *  *new* reaction type goes through the hover-revealed "React" button (ReactionPicker) instead,
 *  not through this row. A group whose `key` is an `mxc://` URL is a custom emote reaction
 *  (ReactionPicker.tsx) rather than plain Unicode — rendered as the image itself (EmoteImage,
 *  which already resolves authenticated media the same way the composer's own emotes do) with
 *  the shortcode, if any, as its tooltip/alt text instead of the raw key. */
export function ReactionBar({
  groups,
  onToggle,
}: {
  groups: ReactionGroup[];
  onToggle: (group: ReactionGroup) => void;
}) {
  if (groups.length === 0) return null;

  return (
    <div className="nu-reaction-bar" data-nu-role="reaction-bar">
      {groups.map((group) => {
        const isEmote = group.key.startsWith('mxc://');
        return (
          <button
            key={group.key}
            type="button"
            className={group.hasOwnReaction ? 'nu-reaction-pill nu-reaction-pill--own' : 'nu-reaction-pill'}
            data-nu-role="reaction-pill"
            title={isEmote && group.shortcode ? `:${group.shortcode}:` : group.key}
            onClick={() => onToggle(group)}
          >
            {isEmote ? (
              <EmoteImage shortcode={group.shortcode ?? 'emote'} mxcUrl={group.key} />
            ) : (
              <span className="nu-reaction-pill__key">{group.key}</span>
            )}
            <span className="nu-reaction-pill__count">{group.count}</span>
          </button>
        );
      })}
    </div>
  );
}
