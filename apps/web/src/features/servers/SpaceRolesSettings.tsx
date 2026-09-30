import { useState, type FormEvent } from 'react';
import { EventType, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { useSpaceRoles } from '../../matrix/hooks/useSpaceRoles';
import { canSendStateEvent, userPowerLevel } from '../../matrix/permissions';
import {
  CAPABILITIES,
  capabilityLevel,
  MAX_CUSTOM_ROLES,
  roleFor,
  ROLES_EVENT,
  saveCustomRoles,
  withCapability,
  type Capability,
  type RoleLevel,
} from '../../matrix/roles';

/** Levels a custom role may take: between Member and Admin, not Moderator's own. */
const MIN_LEVEL = 1;
const MAX_LEVEL = 99;
const DEFAULT_COLOR = '#7fb2ff';

function newRoleId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * A Space's roles (matrix/roles.ts, docs/roles.md): its own roles between Member and Admin, each a
 * name, a colour and a level, and the lowest role that can do each thing. People get a role in
 * Members; the role sync carries both into every channel.
 */
export function SpaceRolesSettings({ space }: { space: Room }) {
  const mx = useMatrixClient();
  const myUserId = mx.getUserId() ?? '';
  const roles = useSpaceRoles(space);
  const custom = roles.filter((role) => role.custom);
  const canEditRoles = canSendStateEvent(space, myUserId, ROLES_EVENT);
  const canEditCapabilities = canSendStateEvent(space, myUserId, EventType.RoomPowerLevels);
  const myLevel = userPowerLevel(space, myUserId);
  const [name, setName] = useState('');
  const [level, setLevel] = useState(25);
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const levelTaken = roles.some((role) => role.value === level);
  const levelProblem =
    !Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL
      ? `A level between ${MIN_LEVEL} and ${MAX_LEVEL}.`
      : levelTaken
        ? `${roleFor(level, roles).label} already has level ${level}.`
        : undefined;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the roles');
    } finally {
      setBusy(false);
    }
  };

  const save = (next: RoleLevel[]) => run(() => saveCustomRoles(mx, space, next));

  const addRole = (evt: FormEvent) => {
    evt.preventDefault();
    if (!name.trim() || levelProblem) return;
    const role: RoleLevel = { id: `custom:${newRoleId()}`, label: name.trim(), pluralLabel: name.trim(), value: level, color, custom: true };
    void save([...custom, role]).then(() => setName(''));
  };

  const setCapability = (capability: Capability, value: number) =>
    run(async () => {
      const current = space.currentState.getStateEvents(EventType.RoomPowerLevels, '')?.getContent() ?? {};
      await mx.sendStateEvent(space.roomId, EventType.RoomPowerLevels, withCapability(current, capability, value) as any, '');
      // Thresholds reach the channels once the Space has its roles set up (channelPermissions.ts).
      if (!space.currentState.getStateEvents(ROLES_EVENT, '')) await saveCustomRoles(mx, space, custom);
    });

  const levels = space.currentState.getStateEvents(EventType.RoomPowerLevels, '')?.getContent() ?? {};

  return (
    <div className="nu-space-roles" data-nu-role="space-roles">
      <p className="nu-space-members__note">
        Roles rank people: each person has one, and someone with a higher role can do everything a lower one can. Give people a role
        under Members. Everything here reaches every channel of {space.name}.
      </p>

      <ul className="nu-space-roles__list" data-nu-role="space-roles-list">
        {roles.map((role) => (
          <li key={role.id} className="nu-space-roles__row" data-nu-role="space-roles-row">
            <span className="nu-space-roles__swatch" style={{ background: role.color ?? 'var(--nu-color-text-muted)' }} aria-hidden="true" />
            <span className="nu-space-roles__name">{role.label}</span>
            <span className="nu-space-roles__level">Level {role.value}</span>
            {role.custom && canEditRoles && (
              <>
                <input
                  type="color"
                  className="nu-space-roles__color"
                  aria-label={`${role.label}’s colour`}
                  value={role.color ?? DEFAULT_COLOR}
                  disabled={busy}
                  onChange={(e) => void save(custom.map((r) => (r.id === role.id ? { ...r, color: e.target.value } : r)))}
                />
                <button
                  type="button"
                  className="nu-space-members__role-button nu-space-members__role-button--danger"
                  data-nu-role="space-roles-delete"
                  disabled={busy}
                  onClick={() => void save(custom.filter((r) => r.id !== role.id))}
                >
                  Delete
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {custom.length > 0 && (
        <p className="nu-field__hint">Deleting a role leaves its people at its level; they show as the next role down.</p>
      )}

      {canEditRoles && custom.length < MAX_CUSTOM_ROLES && (
        <form className="nu-space-roles__add" onSubmit={addRole} data-nu-role="space-roles-add">
          <label className="nu-field">
            New role
            <input
              className="nu-field__input"
              data-nu-role="space-roles-name"
              value={name}
              maxLength={32}
              placeholder="Helper"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="nu-field nu-space-roles__level-field">
            Level
            <input
              type="number"
              className="nu-field__input"
              data-nu-role="space-roles-level"
              min={MIN_LEVEL}
              max={MAX_LEVEL}
              value={level}
              onChange={(e) => setLevel(Number(e.target.value))}
            />
          </label>
          <label className="nu-field nu-space-roles__level-field">
            Colour
            <input type="color" className="nu-space-roles__color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          <button type="submit" className="nu-button nu-button--primary" data-nu-role="space-roles-create" disabled={busy || !name.trim() || !!levelProblem}>
            Add role
          </button>
          {name.trim() && levelProblem && <p className="nu-field__error">{levelProblem}</p>}
          <p className="nu-field__hint nu-space-roles__add-hint">Below 50 is under Moderator, above it between Moderator and Admin.</p>
        </form>
      )}

      <h3 className="nu-space-roles__heading">What each role can do</h3>
      <div className="nu-space-roles__capabilities" data-nu-role="space-roles-capabilities">
        {CAPABILITIES.map((capability) => {
          const current = capabilityLevel(levels, capability.id);
          // A choice at or below your own level: the homeserver refuses the rest.
          const choices = roles.filter((role) => role.value <= myLevel);
          const shown = choices.some((role) => role.value === current)
            ? choices
            : [...choices, { id: 'current', label: `Level ${current}`, pluralLabel: '', value: current }];
          return (
            <label key={capability.id} className="nu-field nu-space-roles__capability">
              {capability.label}
              <select
                className="nu-field__input"
                data-nu-role={`space-roles-capability-${capability.id}`}
                value={current}
                disabled={busy || !canEditCapabilities || current > myLevel}
                onChange={(e) => void setCapability(capability.id, Number(e.target.value))}
              >
                {shown.map((role) => (
                  <option key={role.id} value={role.value}>
                    {role.id === 'member' ? 'Everyone' : `${role.label} and up`}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
      {error && <p className="nu-field__error">{error}</p>}
    </div>
  );
}
