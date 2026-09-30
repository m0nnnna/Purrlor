import type { RoleLevel } from '../matrix/roles';
import { Icon } from './Icon';
import './RoleBadge.css';

/** After a name — in the member list and next to a message's sender: a crown for an admin, a
 *  shield for a moderator, and a custom role's mark in its own colour. Nothing for a member. */
export function RoleBadge({ role }: { role: RoleLevel }) {
  if (role.id === 'member') return null;
  const icon = role.id === 'admin' ? 'crown' : role.id === 'moderator' ? 'shield' : 'sparkle';
  return (
    <span
      className={`nu-role-badge nu-role-badge--${role.custom ? 'custom' : role.id}`}
      data-nu-role="role-badge"
      title={role.label}
      aria-label={role.label}
      style={role.color ? { color: role.color } : undefined}
    >
      <Icon name={icon} size={12} />
    </span>
  );
}
