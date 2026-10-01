import { useState } from 'react';
import { Modal } from '../components/Modal';
import { AccountGeneralSettings } from './AccountGeneralSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { PrivacySettings } from './PrivacySettings';
import { RemindersSettings } from './RemindersSettings';
import { SessionsSettings } from './SessionsSettings';
import './AccountSettingsModal.css';

type AccountSettingsTab = 'account' | 'sessions' | 'appearance' | 'reminders' | 'privacy';

export function AccountSettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<AccountSettingsTab>('account');

  return (
    <Modal title="Account Settings" onClose={onClose}>
      <div className="nu-modal-tabs" data-nu-role="account-settings-tabs">
        <button
          type="button"
          className={tab === 'account' ? 'nu-modal-tab nu-modal-tab--active' : 'nu-modal-tab'}
          onClick={() => setTab('account')}
        >
          Account
        </button>
        <button
          type="button"
          className={tab === 'sessions' ? 'nu-modal-tab nu-modal-tab--active' : 'nu-modal-tab'}
          onClick={() => setTab('sessions')}
        >
          Sessions
        </button>
        <button
          type="button"
          className={tab === 'appearance' ? 'nu-modal-tab nu-modal-tab--active' : 'nu-modal-tab'}
          onClick={() => setTab('appearance')}
        >
          Appearance
        </button>
        <button
          type="button"
          className={tab === 'reminders' ? 'nu-modal-tab nu-modal-tab--active' : 'nu-modal-tab'}
          data-nu-role="account-settings-reminders-tab"
          onClick={() => setTab('reminders')}
        >
          Reminders
        </button>
        <button
          type="button"
          className={tab === 'privacy' ? 'nu-modal-tab nu-modal-tab--active' : 'nu-modal-tab'}
          data-nu-role="account-settings-privacy-tab"
          onClick={() => setTab('privacy')}
        >
          Privacy
        </button>
      </div>
      {tab === 'account' && <AccountGeneralSettings onClose={onClose} />}
      {tab === 'sessions' && <SessionsSettings />}
      {tab === 'appearance' && <AppearanceSettings />}
      {tab === 'reminders' && <RemindersSettings onClose={onClose} />}
      {tab === 'privacy' && <PrivacySettings />}
    </Modal>
  );
}
