import { useState } from 'react';
import type { Room } from 'matrix-js-sdk';
import { Modal } from '../../components/Modal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { canSendStateEvent } from '../../matrix/permissions';
import { SpaceAuditLogSettings } from './SpaceAuditLogSettings';
import { SpaceCategoriesSettings } from './SpaceCategoriesSettings';
import { SpaceGeneralSettings } from './SpaceGeneralSettings';
import { SpaceDirectorySettings } from './SpaceDirectorySettings';
import { SpaceInviteLinkSettings } from './SpaceInviteLinkSettings';
import { SpaceLeaveSettings } from './SpaceLeaveSettings';
import { SpaceMembersSettings } from './SpaceMembersSettings';
import { SpaceNicknameSettings } from './SpaceNicknameSettings';
import { SpaceReportsSettings } from './SpaceReportsSettings';
import { isSpaceModerator } from '../../matrix/reports';
import './SpaceSettingsModal.css';

type SpaceSettingsTab = 'general' | 'members' | 'categories' | 'invite-link' | 'nickname' | 'audit-log' | 'reports' | 'leave';

type SpaceSettingsModalProps = {
  space: Room;
  onClose: () => void;
};

/**
 * Every tab but "Nickname" is an admin action (renaming the Space, managing members/categories/
 * audit log) — gated the same way the ⚙ button that opens this modal used to be. "Nickname" is a
 * personal preference any member can use regardless of power level, so the ⚙ button is now
 * always shown (ChannelList.tsx), and non-admins land straight on — and only ever see — that one
 * tab here instead of the admin set.
 */
export function SpaceSettingsModal({ space, onClose }: SpaceSettingsModalProps) {
  const mx = useMatrixClient();
  const canManageSpace = canSendStateEvent(space, mx.getUserId() ?? '', 'm.room.name');
  // Reports are for moderators, who aren't necessarily admins.
  const canModerate = isSpaceModerator(space, mx.getUserId() ?? '');
  const [tab, setTab] = useState<SpaceSettingsTab>(canManageSpace ? 'general' : 'nickname');

  return (
    <Modal title="Space Settings" onClose={onClose}>
      <div className="nu-modal-tabs" data-nu-role="space-settings-tabs">
        {canManageSpace && (
          <>
            <button
              type="button"
              className={tab === 'general' ? 'nu-modal-tab nu-modal-tab--active' : 'nu-modal-tab'}
              onClick={() => setTab('general')}
            >
              General
            </button>
            <button
              type="button"
              className={tab === 'members' ? 'nu-modal-tab nu-modal-tab--active' : 'nu-modal-tab'}
              onClick={() => setTab('members')}
            >
              Members
            </button>
            <button
              type="button"
              className={tab === 'categories' ? 'nu-modal-tab nu-modal-tab--active' : 'nu-modal-tab'}
              onClick={() => setTab('categories')}
            >
              Categories
            </button>
            <button
              type="button"
              className={tab === 'invite-link' ? 'nu-modal-tab nu-modal-tab--active' : 'nu-modal-tab'}
              onClick={() => setTab('invite-link')}
            >
              Visibility
            </button>
          </>
        )}
        <button
          type="button"
          className={tab === 'nickname' ? 'nu-modal-tab nu-modal-tab--active' : 'nu-modal-tab'}
          onClick={() => setTab('nickname')}
        >
          Nickname
        </button>
        {canManageSpace && (
          <button
            type="button"
            className={tab === 'audit-log' ? 'nu-modal-tab nu-modal-tab--active' : 'nu-modal-tab'}
            onClick={() => setTab('audit-log')}
          >
            Audit Log
          </button>
        )}
        {canModerate && (
          <button
            type="button"
            className={tab === 'reports' ? 'nu-modal-tab nu-modal-tab--active' : 'nu-modal-tab'}
            data-nu-role="space-settings-reports-tab"
            onClick={() => setTab('reports')}
          >
            Reports
          </button>
        )}
        <button
          type="button"
          className={tab === 'leave' ? 'nu-modal-tab nu-modal-tab--active' : 'nu-modal-tab'}
          data-nu-role="space-settings-leave-tab"
          onClick={() => setTab('leave')}
        >
          Leave
        </button>
      </div>
      {tab === 'general' && canManageSpace && <SpaceGeneralSettings space={space} onClose={onClose} />}
      {tab === 'members' && canManageSpace && <SpaceMembersSettings space={space} />}
      {tab === 'categories' && canManageSpace && <SpaceCategoriesSettings space={space} />}
      {tab === 'invite-link' && canManageSpace && (
        <>
          <SpaceDirectorySettings space={space} />
          <SpaceInviteLinkSettings space={space} />
        </>
      )}
      {tab === 'nickname' && <SpaceNicknameSettings space={space} />}
      {tab === 'audit-log' && canManageSpace && <SpaceAuditLogSettings space={space} />}
      {tab === 'reports' && canModerate && <SpaceReportsSettings space={space} />}
      {tab === 'leave' && <SpaceLeaveSettings space={space} onClose={onClose} />}
    </Modal>
  );
}
