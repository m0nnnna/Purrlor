import { useEffect, useState } from 'react';
import { useSetAtom } from 'jotai';
import { RoomStateEvent, type MatrixEvent } from 'matrix-js-sdk';
import { profileUserIdAtom } from '../../app/state/selection';
import { Icon } from '../../components/Icon';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { readAlertList, shouldAlertOpening } from '../../matrix/commissionAlerts';
import { COMMISSION_STATUS_EVENT, parseCommissionState } from '../../matrix/commissions';
import { handleFor } from '../../matrix/roles';
import '../reminders/ReminderWatcher.css';

/**
 * Tells you when an artist you asked about opens their commissions (matrix/commissionAlerts.ts):
 * a card in the corner, and a desktop notification when the browser allows them. It watches the
 * status change arrive in the artist's profile room, so it comes while a tab is open. Mounted once
 * in AppShell.
 */
export function CommissionAlerts() {
  const mx = useMatrixClient();
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  const [opened, setOpened] = useState<string[]>([]);

  useEffect(() => {
    const onState = (event: MatrixEvent, _state: unknown, previous: MatrixEvent | null) => {
      if (event.getType() !== COMMISSION_STATUS_EVENT) return;
      const sender = event.getSender() ?? '';
      const change = {
        sender,
        status: parseCommissionState(event.getContent())?.status,
        previousStatus: previous ? parseCommissionState(previous.getContent())?.status : undefined,
        ts: event.getTs(),
      };
      if (!shouldAlertOpening(change, readAlertList(mx), mx.getUserId() ?? '')) return;
      setOpened((current) => (current.includes(sender) ? current : [...current, sender]));
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('Commissions open', { body: `${handleFor(sender)} opened their commissions`, tag: `commissions:${sender}` });
      }
    };
    mx.on(RoomStateEvent.Events, onState as never);
    return () => {
      mx.removeListener(RoomStateEvent.Events, onState as never);
    };
  }, [mx]);

  if (opened.length === 0) return null;
  const dismiss = (user: string) => setOpened((current) => current.filter((u) => u !== user));
  return (
    <div className="nu-reminders" data-nu-role="commission-alerts" role="status">
      {opened.map((user) => (
        <div key={user} className="nu-reminders__card" data-nu-role="commission-alert-card">
          <Icon name="bell" size={16} />
          <div className="nu-reminders__text">
            <strong>Commissions open</strong>
            <span>{handleFor(user)} opened their commissions</span>
          </div>
          <button
            type="button"
            className="nu-button nu-button--secondary"
            onClick={() => {
              setProfileUserId(user);
              dismiss(user);
            }}
          >
            Open
          </button>
          <button type="button" className="nu-reminders__dismiss" title="Dismiss" aria-label="Dismiss" onClick={() => dismiss(user)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
