import { useEffect, useState } from 'react';
import { ClientEvent, type MatrixEvent } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { readReminders, REMINDERS_ACCOUNT_DATA, type MessageReminder } from '../reminders';

/** Your pending "remind me about this message" reminders, soonest first, kept current. */
export function useReminders(): MessageReminder[] {
  const mx = useMatrixClient();
  const [items, setItems] = useState(() => readReminders(mx));

  useEffect(() => {
    const onAccountData = (event: MatrixEvent) => {
      if (event.getType() === REMINDERS_ACCOUNT_DATA) setItems(readReminders(mx));
    };
    setItems(readReminders(mx));
    mx.on(ClientEvent.AccountData, onAccountData);
    return () => {
      mx.removeListener(ClientEvent.AccountData, onAccountData);
    };
  }, [mx]);

  return [...items].sort((a, b) => a.remindAt - b.remindAt);
}
