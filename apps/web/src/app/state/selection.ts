import { atom } from 'jotai';
import type { RoomMember } from 'matrix-js-sdk';
import type { Emote } from '../../matrix/emotes';
import type { PostContent, PostOrigin } from '../../matrix/feed';
import type { PostAuthor } from '../../features/feed/PostCard';

/** Currently selected Space (server). `null` = no space selected (e.g. a future "Home"/DM view). */
export const selectedSpaceIdAtom = atom<string | null>(null);

/** Currently selected room (channel) within the selected space. */
export const selectedRoomIdAtom = atom<string | null>(null);

/**
 * A Space-level view that isn't a channel. `'feed'` is the hub's Posts timeline, which is a
 * merge across many rooms (`feed.ts`) rather than any one of them, so it can't be expressed as a
 * `selectedRoomIdAtom` value. `null` means an ordinary channel is selected.
 */
export const selectedSpaceViewAtom = atom<'feed' | 'events' | null>(null);

/**
 * Whether the global feed (public posts from every public Space, see matrix/globalFeed.ts) is
 * open in the main pane. It isn't tied to any Space, so it sits outside `selectedSpaceViewAtom`;
 * picking a Space, a channel, or a Space's own Posts closes it.
 */
export const globalFeedOpenAtom = atom<boolean>(false);

/**
 * Whose profile is open in the main pane (ProfileView), over whatever else is selected. Set from
 * any author name on a post or from a member's profile card; opening a room closes it.
 */
export const profileUserIdAtom = atom<string | null>(null);

/**
 * One post opened on its own page (features/feed/PostPage.tsx), over whatever else is showing —
 * where a long thread is read in full, since timelines only show a post's newest few comments.
 * Carries what the page needs to show the post without looking it up again; going anywhere else
 * closes it, and Back returns to what was underneath.
 */
export type OpenPost = {
  roomId: string;
  postId: string;
  isPublic: boolean;
  canInteract: boolean;
  cannotInteractReason?: string;
  content: PostContent;
  author: PostAuthor;
  ts: number;
  edited?: boolean;
  /** Where the post lives. */
  sourceOrigin: PostOrigin;
  /** Whether the card showed its place as a chip (timelines that mix places do). */
  showOrigin: boolean;
  emotes?: Emote[];
  members?: RoomMember[];
};
export const openPostAtom = atom<OpenPost | null>(null);

/**
 * The voice channel actually connected via LiveKit right now — independent of
 * `selectedRoomIdAtom`. Discord's model: you can be in a voice call while looking at (and
 * `selectedRoomIdAtom`-selecting) a different, unrelated text channel. `null` = not in a call.
 */
export const activeVoiceChannelIdAtom = atom<string | null>(null);

/**
 * A message the UI should scroll to and highlight the moment its room's timeline can show it —
 * set by anything that jumps to a specific message rather than just a room (currently only
 * search results; see MessageSearchModal/MessageTimeline). `null` once consumed or abandoned.
 */
export type PendingJumpTarget = { roomId: string; eventId: string };
export const pendingJumpTargetAtom = atom<PendingJumpTarget | null>(null);
