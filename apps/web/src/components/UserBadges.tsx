import { badgeTextColor, useBadges } from '../matrix/badges';
import './UserBadges.css';

/** The pills an admin gave this person, after their name. Nothing for most people. */
export function UserBadges({ userId }: { userId: string | undefined }) {
  const badges = useBadges(userId);
  if (badges.length === 0) return null;
  return (
    <>
      {badges.map((badge) => (
        <span
          key={badge.id}
          className="nu-user-badge"
          data-nu-role="user-badge"
          title={badge.text}
          style={{ background: badge.color, color: badgeTextColor(badge.color) }}
        >
          {badge.text}
        </span>
      ))}
    </>
  );
}
