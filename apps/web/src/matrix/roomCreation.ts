import {
  EventType,
  HistoryVisibility,
  JoinRule,
  RestrictedAllowType,
  RoomType,
  Visibility,
  type ICreateRoomOpts,
  type ICreateRoomStateEvent,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { channelTypeInitialStateEvent, SPACE_CHILD_CHANNEL_TYPE_KEY, type ChannelType } from './channelType';
import { ENCRYPTION_INITIAL_STATE } from './encryption';

export type CreateRoomOptions = {
  name: string;
  topic?: string;
  isPublic: boolean;
  /** Create a Space instead of a regular room. */
  isSpace?: boolean;
  /** If set, the new room becomes a child of this Space (m.space.child / m.space.parent). */
  parentSpace?: Room;
  /** Text (default) or voice channel — ignored when isSpace is set. */
  channelType?: ChannelType;
  /**
   * Matrix IDs invited as part of creating the room, rather than in a follow-up call. Used for
   * the voice token server's service bot (see matrix/voiceBot.ts), which has to be a member of
   * a voice channel's room before it can authorize anyone into the call — inviting it here
   * makes that atomic with creation instead of a manual step nobody knows to take.
   */
  invite?: string[];
  /** End-to-end encrypted from its first event (encryption.ts). Ignored for a Space, which holds
   *  no messages. */
  encrypted?: boolean;
};

type JoinRuleContent = { join_rule: JoinRule; allow?: { type: RestrictedAllowType; room_id: string }[] };

/**
 * A private voice channel is created `restricted` to its Space rather than invite-only:
 * membership of the Space is what grants access to the channels inside it, which is both
 * Discord's model and what lets the voice token server's service bot join a channel *itself*
 * rather than depending on a per-room invite it has no way to ask for
 * (services/token-server/src/tenancy.ts). It also makes the channel list's "Join" button work
 * for a private channel, which previously only ever worked for public ones.
 *
 * Restricted join rules need room version 9+; `createRoom` falls back to invite-only on a
 * homeserver whose default room version predates that, where the bot's per-room invite (still
 * sent at creation) remains the only way in.
 */
function restrictedParentSpace(options: CreateRoomOptions): Room | undefined {
  if (options.isSpace || options.isPublic) return undefined;
  if (options.channelType !== 'voice') return undefined;
  return options.parentSpace;
}

/**
 * Creates a Space or a regular room, optionally linking it into a parent Space. Deliberately
 * narrow compared to what Matrix supports: no knock join rule, no room-version selection, no
 * additional-creators (MSC multi-creator rooms). Those are legitimate features, just not needed
 * for a first "create and manage spaces" pass.
 */
export async function createRoom(mx: MatrixClient, options: CreateRoomOptions): Promise<string> {
  const via = mx.getUserId()?.split(':')[1] ?? '';

  const request = (joinRule: JoinRuleContent): ICreateRoomOpts => {
    const initialState: ICreateRoomStateEvent[] = [
      { type: EventType.RoomJoinRules, state_key: '', content: joinRule },
    ];

    // A public Space opens its *state* (name, topic, who's a member, and each member's pointer
    // to their Posts feed) to people who haven't joined. That's what lets the global feed show
    // its posts to everyone on the server (matrix/globalFeed.ts). A Space holds no chat of its own
    // — channels are separate rooms with their own settings — so nothing else becomes readable.
    if (options.isSpace && options.isPublic) {
      initialState.push({
        type: EventType.RoomHistoryVisibility,
        state_key: '',
        content: { history_visibility: HistoryVisibility.WorldReadable },
      });
    }

    if (options.parentSpace) {
      initialState.push({
        type: EventType.SpaceParent,
        state_key: options.parentSpace.roomId,
        content: { canonical: true, via: [via] },
      });
    }

    if (!options.isSpace && options.channelType === 'voice') {
      initialState.push(channelTypeInitialStateEvent('voice'));
    }

    if (!options.isSpace && options.encrypted) {
      initialState.push(ENCRYPTION_INITIAL_STATE);
    }

    return {
      name: options.name,
      topic: options.topic || undefined,
      invite: options.invite?.length ? options.invite : undefined,
      // The join_rule above ("who can join if they get in the door") and this are two separate
      // Matrix knobs that both happen to be exposed through one "Public" checkbox in the UI:
      // without also publishing to the directory, a "public" room stayed invisible to
      // DiscoverModal's browsePublicRooms — joinable by anyone who already had the room ID, but
      // undiscoverable by anyone else, which isn't what the checkbox's own label promises.
      visibility: options.isPublic ? Visibility.Public : Visibility.Private,
      creation_content: options.isSpace ? { type: RoomType.Space } : undefined,
      power_level_content_override: options.isSpace ? { events_default: 50 } : undefined,
      initial_state: initialState,
    };
  };

  const plainJoinRule: JoinRuleContent = {
    join_rule: options.isPublic ? JoinRule.Public : JoinRule.Invite,
  };
  const restrictedTo = restrictedParentSpace(options);

  let result: { room_id: string };
  if (restrictedTo) {
    try {
      result = await mx.createRoom(
        request({
          join_rule: JoinRule.Restricted,
          allow: [{ type: RestrictedAllowType.RoomMembership, room_id: restrictedTo.roomId }],
        })
      );
    } catch {
      // Almost always an unsupported room version. Retrying plainly keeps channel creation
      // working on an older homeserver rather than failing it over an access-model upgrade;
      // if the request is broken for some other reason, this second attempt surfaces that.
      result = await mx.createRoom(request(plainJoinRule));
    }
  } else {
    result = await mx.createRoom(request(plainJoinRule));
  }

  if (options.parentSpace) {
    await mx.sendStateEvent(
      options.parentSpace.roomId,
      EventType.SpaceChild,
      {
        via: [via],
        suggested: false,
        // Lets the voice bot find and join it without an invite (channelType.ts).
        ...(!options.isSpace && options.channelType === 'voice' && { [SPACE_CHILD_CHANNEL_TYPE_KEY]: 'voice' }),
      },
      result.room_id
    );
  }

  return result.room_id;
}

/** Reads the room's current join rule, defaulting to Invite (the spec default for an unset event). */
export function getJoinRule(room: Room): JoinRule {
  return (
    room.currentState.getStateEvents(EventType.RoomJoinRules, '')?.getContent<{ join_rule: JoinRule }>()
      .join_rule ?? JoinRule.Invite
  );
}

/**
 * Flips only the join rule — deliberately separate from `createRoom`'s combined isPublic flag
 * (which also touches directory visibility): this is what backs an existing Space's "Public join
 * link" toggle (SpaceInviteLinkSettings.tsx), which should NOT also publish the Space to the
 * Discover directory just because it became joinable by link.
 */
export async function setJoinRule(mx: MatrixClient, roomId: string, rule: JoinRule): Promise<void> {
  await mx.sendStateEvent(roomId, EventType.RoomJoinRules, { join_rule: rule });
}

export async function updateRoomAvatar(mx: MatrixClient, roomId: string, file: File): Promise<void> {
  const { content_uri: mxcUrl } = await mx.uploadContent(file);
  await mx.sendStateEvent(roomId, EventType.RoomAvatar, { url: mxcUrl });
}

export async function updateRoomName(mx: MatrixClient, roomId: string, name: string): Promise<void> {
  await mx.sendStateEvent(roomId, EventType.RoomName, { name });
}

export async function updateRoomTopic(mx: MatrixClient, roomId: string, topic: string): Promise<void> {
  await mx.sendStateEvent(roomId, EventType.RoomTopic, { topic });
}
