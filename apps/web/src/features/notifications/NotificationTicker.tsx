import { useAtomValue } from 'jotai';
import { activityAtom } from '../../app/state/feed';
import { formatClock12 } from '../../app/StatusClock';
import { isUnread, type ActivityItem } from '../../matrix/activity';
import { useUserProfile } from '../../matrix/hooks/useUserProfile';
import { VERBS } from '../feed/ActivityView';
import { useOpenSocial } from '../feed/useOpenSocial';
import './NotificationTicker.css';

/** How many of the newest notifications scroll past. */
const SHOWN = 8;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Today's as a 12-hour time; anything older as its date, the way the status clock writes dates. */
export function tickerTime(ts: number, now = new Date()): string {
  const d = new Date(ts);
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? formatClock12(d, false) : `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}`;
}

function TickerItem({ item, unread }: { item: ActivityItem; unread: boolean }) {
  const first = useUserProfile(item.senders[0]).name;
  const others = item.senders.length - 1;
  const who = others > 0 ? `${first} and ${others === 1 ? '1 other' : `${others} others`}` : first;
  return (
    <span className={unread ? 'nu-ticker__item nu-ticker__item--new' : 'nu-ticker__item'}>
      <span className="nu-ticker__time">{tickerTime(item.ts)}</span>
      {who} {VERBS[item.kind]}
    </span>
  );
}

/**
 * The Ultimit desktop's news ticker, carrying your notifications: the newest few scroll along the
 * bottom of the app, and the strip opens Notifications. Hidden on a phone, and off when Appearance
 * settings turn it off (app/effects.ts). It stands still with less motion or Safe effects
 * (styles/base/frame.css), showing as many as fit.
 */
export function NotificationTicker() {
  const activity = useAtomValue(activityAtom);
  const openSocial = useOpenSocial();
  const items = activity.items.slice(0, SHOWN);
  const unread = activity.items.filter((item) => isUnread(item, activity.seenTs)).length;
  return (
    <button
      type="button"
      className="nu-ticker"
      data-nu-role="notification-ticker"
      aria-label={unread > 0 ? `Notifications, ${unread} new` : 'Notifications'}
      onClick={() => openSocial('notifications')}
    >
      <span className="nu-ticker__key" aria-hidden="true">
        NOTIFY{unread > 0 && <span className="nu-ticker__count">{unread > 99 ? '99+' : unread}</span>}
      </span>
      <span className="nu-ticker__track" aria-hidden="true">
        {items.length === 0 ? (
          <span className="nu-ticker__empty">{activity.loaded ? 'Nothing new. Likes, comments, follows and mentions show up here.' : 'Reading notifications…'}</span>
        ) : (
          // Its length sets its speed, so a long line doesn't race past.
          <span className="nu-ticker__run" style={{ animationDuration: `${Math.max(30, items.length * 9)}s` }}>
            {items.map((item, i) => (
              <span key={item.key} className="nu-ticker__entry">
                {i > 0 && <span className="nu-ticker__sep">◆</span>}
                <TickerItem item={item} unread={isUnread(item, activity.seenTs)} />
              </span>
            ))}
          </span>
        )}
      </span>
    </button>
  );
}
