import { useEffect, useState } from 'react';
import { ClientEvent, type MatrixEvent } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { mutedPostIds, setPostMuted } from '../postNotifications';

/** Whether you've muted a post's notifications, and the switch. Follows your push rules, so muting
 *  on another device shows here too. */
export function usePostMuted(roomId: string, postId: string) {
  const mx = useMatrixClient();
  const [muted, setMuted] = useState(() => mutedPostIds(mx).has(postId));

  useEffect(() => {
    setMuted(mutedPostIds(mx).has(postId));
    const onAccountData = (event: MatrixEvent) => {
      if (event.getType() === 'm.push_rules') setMuted(mutedPostIds(mx).has(postId));
    };
    mx.on(ClientEvent.AccountData, onAccountData);
    return () => {
      mx.removeListener(ClientEvent.AccountData, onAccountData);
    };
  }, [mx, postId]);

  const toggle = async () => {
    const next = !muted;
    setMuted(next);
    try {
      await setPostMuted(mx, roomId, postId, next);
    } catch (err) {
      setMuted(!next);
      throw err;
    }
  };

  return { muted, toggle };
}
