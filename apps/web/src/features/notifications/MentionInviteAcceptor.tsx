import { useEffect, useRef } from 'react';
import { ClientEvent, RoomEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { feedJoinVia } from '../../matrix/feed';
import { addMentionToInbox } from '../../matrix/mentionInbox';
import { readMentionInvite } from '../../matrix/mentionInvites';
import { useOpenPost } from '../feed/useOpenPost';

/**
 * Accepts the invites that carry a Global-post mention (matrix/mentionInvites.ts): joins the
 * author's profile room, files the mention in the Mention Inbox, and, for one that arrives while
 * the app is open, shows a desktop notification that opens the post. Ones that arrived while the
 * app was closed are accepted and filed quietly at start (background push already told you).
 *
 * Headless: mounted once in AppShell, renders nothing.
 */
export function MentionInviteAcceptor() {
  const mx = useMatrixClient();
  const openPost = useOpenPost();
  const openPostRef = useRef(openPost);
  openPostRef.current = openPost;

  useEffect(() => {
    const handling = new Set<string>();

    const accept = async (room: Room, live: boolean) => {
      const mention = readMentionInvite(mx, room);
      if (!mention || handling.has(room.roomId)) return;
      handling.add(room.roomId);
      try {
        const inviterName = room.getMember(mention.inviter)?.name ?? mention.inviter;
        await mx.joinRoom(room.roomId, { viaServers: feedJoinVia(room.roomId, mention.inviter) });
        await addMentionToInbox(mx, room.roomId, mention.postId, mention.postId);
        if (live && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const notification = new Notification(inviterName, { body: mention.tagged ? 'Tagged you in a photo' : 'Mentioned you in a post', tag: `${room.roomId}:mention` });
          notification.onclick = () => {
            window.focus();
            void openPostRef.current(room.roomId, mention.postId);
            notification.close();
          };
        }
      } catch (err) {
        console.warn('Couldn’t accept a mention', err);
      } finally {
        handling.delete(room.roomId);
      }
    };

    mx.getRooms().forEach((room) => void accept(room, false));
    const onMembership = (room: Room, membership: string) => {
      if (membership === 'invite') void accept(room, true);
    };
    // A brand-new invited room can announce itself before its invite state is filled in, so the
    // room appearing is checked too; `handling` keeps the two from joining twice.
    const onRoom = (room: Room) => void accept(room, true);
    mx.on(RoomEvent.MyMembership, onMembership);
    mx.on(ClientEvent.Room, onRoom);
    return () => {
      mx.removeListener(RoomEvent.MyMembership, onMembership);
      mx.removeListener(ClientEvent.Room, onRoom);
    };
  }, [mx]);

  return null;
}
