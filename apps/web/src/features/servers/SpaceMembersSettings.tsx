import { useEffect, useState, type FormEvent } from 'react';
import { RoomStateEvent, type Room, type RoomMember } from 'matrix-js-sdk';
import { Avatar } from '../../components/Avatar';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { isValidUserId } from '../../matrix/directMessages';
import { useRoomMembers } from '../../matrix/hooks/useRoomMembers';
import { banMember, inviteMember, kickMember, unbanMember } from '../../matrix/moderation';
import { roleFor, type RoleLevel } from '../../matrix/roles';
import { useSpaceRoles } from '../../matrix/hooks/useSpaceRoles';
import { canBanFromRoom, canInviteToRoom, canKickFromRoom, canManageBans, canSendStateEvent } from '../../matrix/permissions';

/** Banned members don't show up in `useRoomMembers` (joined members only) — a room's banned
 *  list is small and only needed here (the one place an Unban action makes sense), so this
 *  stays a local hook rather than something shared. */
function useBannedMembers(room: Room): RoomMember[] {
  const [members, setMembers] = useState<RoomMember[]>(() => room.getMembersWithMembership('ban'));

  useEffect(() => {
    const update = () => setMembers(room.getMembersWithMembership('ban'));
    update();
    room.on(RoomStateEvent.Events, update);
    return () => {
      room.removeListener(RoomStateEvent.Events, update);
    };
  }, [room]);

  return members;
}

function MemberRow({
  member,
  roles,
  myPowerLevel,
  canManageRoles,
  canKick,
  canBan,
  onSetPowerLevel,
  onKick,
  onBan,
}: {
  member: RoomMember;
  roles: RoleLevel[];
  myPowerLevel: number;
  canManageRoles: boolean;
  canKick: boolean;
  canBan: boolean;
  onSetPowerLevel: (userId: string, level: number) => void;
  onKick: (userId: string) => void;
  onBan: (userId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const rolesManageable = canManageRoles && member.powerLevel < myPowerLevel;
  const availableLevels = roles.filter((role) => role.value <= myPowerLevel);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nu-space-members__row" data-nu-role="space-members-row">
      <Avatar name={member.name} mxcUrl={member.getMxcAvatarUrl()} size={28} />
      <div className="nu-space-members__row-info">
        <span className="nu-space-members__row-name">{member.name}</span>
        <span className="nu-space-members__row-role">{roleFor(member.powerLevel, roles).label}</span>
      </div>
      {rolesManageable && (
        <div className="nu-space-members__row-actions">
          {availableLevels.map((role) => (
            <button
              key={role.value}
              type="button"
              className="nu-space-members__role-button"
              data-nu-role="space-members-set-role"
              disabled={busy || role.value === member.powerLevel}
              onClick={() => run(() => Promise.resolve(onSetPowerLevel(member.userId, role.value)))}
            >
              {role.label}
            </button>
          ))}
        </div>
      )}
      {(canKick || canBan) && (
        <div className="nu-space-members__row-actions">
          {canKick && (
            <button
              type="button"
              className="nu-space-members__role-button"
              data-nu-role="space-members-kick"
              disabled={busy}
              onClick={() => run(() => Promise.resolve(onKick(member.userId)))}
            >
              Kick
            </button>
          )}
          {canBan && (
            <button
              type="button"
              className="nu-space-members__role-button nu-space-members__role-button--danger"
              data-nu-role="space-members-ban"
              disabled={busy}
              onClick={() => run(() => Promise.resolve(onBan(member.userId)))}
            >
              Ban
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function BannedRow({ member, onUnban }: { member: RoomMember; onUnban: (userId: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="nu-space-members__row" data-nu-role="space-members-banned-row">
      <Avatar name={member.name} mxcUrl={member.getMxcAvatarUrl()} size={28} />
      <div className="nu-space-members__row-info">
        <span className="nu-space-members__row-name">{member.name}</span>
      </div>
      <div className="nu-space-members__row-actions">
        <button
          type="button"
          className="nu-space-members__role-button"
          data-nu-role="space-members-unban"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onUnban(member.userId);
            } finally {
              setBusy(false);
            }
          }}
        >
          Unban
        </button>
      </div>
    </div>
  );
}

export function SpaceMembersSettings({ space }: { space: Room }) {
  const mx = useMatrixClient();
  const members = useRoomMembers(space.roomId);
  const roles = useSpaceRoles(space);
  const bannedMembers = useBannedMembers(space);
  const [inviteUserId, setInviteUserId] = useState('');
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string>();

  const myUserId = mx.getUserId() ?? '';
  const myPowerLevel = space.getMember(myUserId)?.powerLevel ?? 0;
  const canManagePowerLevels = canSendStateEvent(space, myUserId, 'm.room.power_levels');
  const canInvite = canInviteToRoom(space, myUserId);
  const canBan = canManageBans(space, myUserId);

  const handleSetPowerLevel = async (userId: string, level: number) => {
    setError(undefined);
    try {
      await mx.setPowerLevel(space.roomId, userId, level);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    }
  };

  const handleKick = async (userId: string) => {
    setError(undefined);
    try {
      await kickMember(mx, space.roomId, userId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to kick member');
    }
  };

  const handleBan = async (userId: string) => {
    setError(undefined);
    try {
      await banMember(mx, space.roomId, userId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to ban member');
    }
  };

  const handleUnban = async (userId: string) => {
    setError(undefined);
    try {
      await unbanMember(mx, space.roomId, userId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unban member');
    }
  };

  const handleInvite = async (evt: FormEvent) => {
    evt.preventDefault();
    const trimmed = inviteUserId.trim();
    if (!trimmed || inviting) return;
    if (!isValidUserId(trimmed)) {
      setError('Enter a full Matrix ID, like @friend:example.com');
      return;
    }
    setInviting(true);
    setError(undefined);
    try {
      await inviteMember(mx, space.roomId, trimmed);
      setInviteUserId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite');
    } finally {
      setInviting(false);
    }
  };

  const sorted = [...members].sort((a, b) => b.powerLevel - a.powerLevel || a.name.localeCompare(b.name));

  return (
    <div className="nu-space-members" data-nu-role="space-members">
      <p className="nu-space-members__note">
        A role given here reaches every channel of the Space: whichever admin or moderator has
        Purrlor open copies it in. Make your own roles under Roles.
      </p>
      {!canManagePowerLevels && (
        <p className="nu-space-members__note">You don't have permission to change roles here.</p>
      )}
      {canInvite && (
        <form className="nu-space-members__invite" onSubmit={handleInvite}>
          <input
            className="nu-field__input"
            data-nu-role="space-members-invite-input"
            value={inviteUserId}
            onChange={(e) => setInviteUserId(e.target.value)}
            placeholder="@friend:example.com"
          />
          <button
            type="submit"
            className="nu-button nu-button--primary"
            data-nu-role="space-members-invite-submit"
            disabled={!inviteUserId.trim() || inviting}
          >
            {inviting ? 'Inviting…' : 'Invite'}
          </button>
        </form>
      )}
      {error && (
        <p className="nu-field__error" data-nu-role="space-members-error">
          {error}
        </p>
      )}
      <div className="nu-space-members__list">
        {sorted.map((member) => (
          <MemberRow
            key={member.userId}
            member={member}
            roles={roles}
            myPowerLevel={myPowerLevel}
            canManageRoles={canManagePowerLevels}
            canKick={member.userId !== myUserId && canKickFromRoom(space, myUserId, member.powerLevel)}
            canBan={member.userId !== myUserId && canBanFromRoom(space, myUserId, member.powerLevel)}
            onSetPowerLevel={handleSetPowerLevel}
            onKick={handleKick}
            onBan={handleBan}
          />
        ))}
      </div>
      {canBan && bannedMembers.length > 0 && (
        <>
          <p className="nu-space-members__note">Banned</p>
          <div className="nu-space-members__list">
            {bannedMembers.map((member) => (
              <BannedRow key={member.userId} member={member} onUnban={handleUnban} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
