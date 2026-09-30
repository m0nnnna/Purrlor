import { EventType, MatrixEvent, Room, RoomType, type MatrixClient } from 'matrix-js-sdk';
import {
  DEMO_BOT_USER_ID,
  DEMO_LIVEKIT_URL,
  DEMO_SERVER_NAME,
  DEMO_TOKEN_ENDPOINT,
  DEMO_USER_ID,
} from './demoMode';

/**
 * The fabricated world demo mode runs on.
 *
 * Built out of **real** `Room` and `MatrixEvent` objects from matrix-js-sdk, not hand-rolled
 * look-alikes. That matters: every read path the app uses — `currentState.getStateEvents` for
 * this codebase's custom markers, `getMember().powerLevel`, `getJoinedMembers`, `isSpaceRoom`,
 * the live timeline — is then the SDK's own implementation rather than a second, subtly
 * different one written here that would drift. The only thing faked is the client that would
 * normally have fetched all this (demoClient.ts).
 */

const ts = (minutesAgo: number) => Date.now() - minutesAgo * 60_000;

let eventCounter = 0;
function nextEventId(): string {
  eventCounter += 1;
  return `$demo-${eventCounter}:${DEMO_SERVER_NAME}`;
}

type EventInit = {
  type: string;
  content: Record<string, unknown>;
  sender?: string;
  stateKey?: string;
  ts?: number;
  eventId?: string;
};

export function demoEvent(roomId: string, init: EventInit): MatrixEvent {
  return new MatrixEvent({
    type: init.type,
    content: init.content,
    sender: init.sender ?? DEMO_USER_ID,
    room_id: roomId,
    event_id: init.eventId ?? nextEventId(),
    origin_server_ts: init.ts ?? Date.now(),
    ...(init.stateKey !== undefined ? { state_key: init.stateKey } : {}),
  });
}

export const DEMO_MEMBERS = [
  { userId: DEMO_USER_ID, name: 'You', powerLevel: 100 },
  { userId: `@nibbles:${DEMO_SERVER_NAME}`, name: 'Nibbles', powerLevel: 50 },
  { userId: `@pixel:${DEMO_SERVER_NAME}`, name: 'Pixel', powerLevel: 0 },
  { userId: `@mochi:${DEMO_SERVER_NAME}`, name: 'Mochi', powerLevel: 0 },
] as const;

const NIBBLES = DEMO_MEMBERS[1].userId;
const PIXEL = DEMO_MEMBERS[2].userId;
const MOCHI = DEMO_MEMBERS[3].userId;

export const DEMO_ROOM_IDS = {
  cafe: `!cafe:${DEMO_SERVER_NAME}`,
  general: `!general:${DEMO_SERVER_NAME}`,
  introductions: `!introductions:${DEMO_SERVER_NAME}`,
  lounge: `!lounge:${DEMO_SERVER_NAME}`,
  afk: `!afk:${DEMO_SERVER_NAME}`,
  arcade: `!arcade:${DEMO_SERVER_NAME}`,
  gaming: `!gaming:${DEMO_SERVER_NAME}`,
  gameNight: `!game-night:${DEMO_SERVER_NAME}`,
  feedYou: `!feed-you:${DEMO_SERVER_NAME}`,
  feedNibbles: `!feed-nibbles:${DEMO_SERVER_NAME}`,
  feedPixel: `!feed-pixel:${DEMO_SERVER_NAME}`,
  review: `!review:${DEMO_SERVER_NAME}`,
  dmNibbles: `!dm-nibbles:${DEMO_SERVER_NAME}`,
  groupChat: `!group-chat:${DEMO_SERVER_NAME}`,
} as const;

/** Members present in a room, as `m.room.member` state. */
function memberEvents(roomId: string, userIds: readonly string[]): MatrixEvent[] {
  return userIds.map((userId) => {
    const member = DEMO_MEMBERS.find((m) => m.userId === userId);
    return demoEvent(roomId, {
      type: EventType.RoomMember,
      stateKey: userId,
      sender: userId,
      content: { membership: 'join', displayname: member?.name ?? userId.slice(1).split(':')[0] },
    });
  });
}

function powerLevelEvent(roomId: string, userIds: readonly string[]): MatrixEvent {
  const users: Record<string, number> = {};
  userIds.forEach((userId) => {
    const member = DEMO_MEMBERS.find((m) => m.userId === userId);
    if (member) users[userId] = member.powerLevel;
  });
  return demoEvent(roomId, {
    type: EventType.RoomPowerLevels,
    stateKey: '',
    content: { users, users_default: 0, state_default: 50, events_default: 0, invite: 0, kick: 50, ban: 50, redact: 50 },
  });
}

type RoomSeed = {
  roomId: string;
  name: string;
  /** The room's type (`m.room.create` content), for rooms the app keeps for itself. */
  roomType?: string;
  topic?: string;
  isSpace?: boolean;
  /** Voice channel marker (`xyz.nekous.channel_type`). */
  voice?: boolean;
  /** Feed room marker plus its owner — a member's posts timeline, see matrix/feed.ts. */
  feed?: string;
  /** The Space a feed belongs to — Cat Café unless said otherwise. */
  feedSpace?: string;
  members?: readonly string[];
  /** Extra state events beyond the standard create/name/members/power-levels set. */
  state?: (roomId: string) => MatrixEvent[];
  timeline?: (roomId: string) => MatrixEvent[];
};

function buildRoom(client: MatrixClient, seed: RoomSeed): Room {
  const room = new Room(seed.roomId, client, DEMO_USER_ID, { pendingEventOrdering: 'detached' as never });
  const members = seed.members ?? DEMO_MEMBERS.map((m) => m.userId);

  const state: MatrixEvent[] = [
    demoEvent(seed.roomId, {
      type: EventType.RoomCreate,
      stateKey: '',
      content: {
        creator: DEMO_USER_ID,
        room_version: '10',
        ...(seed.isSpace ? { type: RoomType.Space } : seed.roomType ? { type: seed.roomType } : {}),
      },
    }),
    demoEvent(seed.roomId, { type: EventType.RoomName, stateKey: '', content: { name: seed.name } }),
    ...(seed.topic
      ? [demoEvent(seed.roomId, { type: EventType.RoomTopic, stateKey: '', content: { topic: seed.topic } })]
      : []),
    ...memberEvents(seed.roomId, members),
    powerLevelEvent(seed.roomId, members),
    ...(seed.voice
      ? [demoEvent(seed.roomId, { type: 'xyz.nekous.channel_type', stateKey: '', content: { type: 'voice' } })]
      : []),
    ...(seed.feed
      ? [
          demoEvent(seed.roomId, { type: 'xyz.nekous.channel_type', stateKey: '', content: { type: 'feed' } }),
          demoEvent(seed.roomId, {
            type: 'xyz.nekous.feed',
            stateKey: '',
            content: { owner: seed.feed, spaceId: seed.feedSpace ?? DEMO_ROOM_IDS.cafe },
          }),
        ]
      : []),
    ...(seed.state?.(seed.roomId) ?? []),
  ];

  room.currentState.setStateEvents(state);
  room.recalculate();

  const timeline = seed.timeline?.(seed.roomId) ?? [];
  if (timeline.length > 0) {
    room.addLiveEvents(timeline, { addToState: false } as never);
  }
  return room;
}

/**
 * A member's `m.room.member` event in the Space, re-sent carrying the pointer to their feed room.
 * That custom key is exactly how the real thing publishes it (matrix/feed.ts): it's the one piece
 * of Space state an ordinary member can write and everyone can read.
 */
function feedPointerEvent(spaceId: string, userId: string, feedRoomId: string): MatrixEvent {
  const member = DEMO_MEMBERS.find((m) => m.userId === userId);
  return demoEvent(spaceId, {
    type: EventType.RoomMember,
    stateKey: userId,
    sender: userId,
    content: {
      membership: 'join',
      displayname: member?.name ?? userId,
      'xyz.nekous.feed_room': feedRoomId,
    },
  });
}

/** A post on someone's feed — `xyz.nekous.post`, not an `m.room.message`. */
function demoPost(roomId: string, sender: string, body: string, minutesAgo: number, eventId?: string): MatrixEvent {
  return demoEvent(roomId, { type: 'xyz.nekous.post', sender, content: { body }, ts: ts(minutesAgo), eventId });
}

/** `m.space.child` + the reciprocal `m.space.parent`, which is how voice.ts finds a Space. */
function spaceChildEvents(spaceId: string, childIds: readonly string[]): MatrixEvent[] {
  return childIds.map((childId, index) =>
    demoEvent(spaceId, {
      type: EventType.SpaceChild,
      stateKey: childId,
      content: { via: [DEMO_SERVER_NAME], order: String(index).padStart(3, '0') },
    })
  );
}

function spaceParentEvent(roomId: string, spaceId: string): MatrixEvent {
  return demoEvent(roomId, {
    type: EventType.SpaceParent,
    stateKey: spaceId,
    content: { canonical: true, via: [DEMO_SERVER_NAME] },
  });
}

function textMessage(
  roomId: string,
  sender: string,
  body: string,
  minutesAgo: number,
  extra: Record<string, unknown> = {}
): MatrixEvent {
  return demoEvent(roomId, {
    type: EventType.RoomMessage,
    sender,
    ts: ts(minutesAgo),
    content: { msgtype: 'm.text', body, ...extra },
  });
}

/**
 * Bodies here are written in Markdown on purpose. This app renders from the plain-text `body`
 * with its own parser (features/messaging/renderMessageText.tsx) rather than from an HTML
 * `formatted_body`, so Markdown in the body is what actually exercises bold/italic/code/fences/
 * spoilers on screen — the thing a demo most needs to show.
 */
const REPORTED_MESSAGE_ID = '$demo-reported-message';
const REPORTED_POST_ID = '$demo-reported-post';

/** A local time `days` from now, as a timestamp. */
function inDays(days: number, hour: number): number {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

const GENERAL_TIMELINE = (roomId: string): MatrixEvent[] => {
  const welcome = textMessage(roomId, NIBBLES, 'welcome to the café ☕', 240);
  const reactTarget = textMessage(
    roomId,
    PIXEL,
    'finally got the **H.264** screen share running at *60fps*',
    180
  );

  return [
    welcome,
    textMessage(roomId, MOCHI, 'is this thing on?', 235),
    reactTarget,
    demoEvent(roomId, {
      type: EventType.Reaction,
      sender: NIBBLES,
      ts: ts(179),
      content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: reactTarget.getId(), key: '🔥' } },
    }),
    demoEvent(roomId, {
      type: EventType.Reaction,
      sender: MOCHI,
      ts: ts(178),
      content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: reactTarget.getId(), key: '🔥' } },
    }),
    textMessage(
      roomId,
      MOCHI,
      'the trick was setting `maxFramerate` explicitly:\n```ts\nscreenShareEncoding: {\n  maxBitrate: 8_000_000,\n  maxFramerate: 60,\n}\n```',
      120
    ),
    // A fixed ID so the sample report below can point at it.
    demoEvent(roomId, {
      type: EventType.RoomMessage,
      sender: PIXEL,
      ts: ts(90),
      eventId: REPORTED_MESSAGE_ID,
      content: { msgtype: 'm.text', body: 'careful though ||it pegs a weak server on packet crypto||' },
    }),
    // What a webhook posts: the Space's service bot, carrying the webhook's name (matrix/webhooks.ts).
    demoEvent(roomId, {
      type: EventType.RoomMessage,
      sender: DEMO_BOT_USER_ID,
      ts: ts(75),
      content: {
        msgtype: 'm.notice',
        body: 'Build 42 passed ✅',
        'com.beeper.per_message_profile': { id: 'demo-deploys', displayname: 'Deploys' },
      },
    }),
    demoEvent(roomId, {
      type: EventType.RoomMessage,
      sender: NIBBLES,
      ts: ts(45),
      content: {
        msgtype: 'm.text',
        body: 'You: can you take a look at the voice channel setup?',
        'm.mentions': { user_ids: [DEMO_USER_ID] },
      },
    }),
    textMessage(roomId, DEMO_USER_ID, 'on it — the bot invites itself now, should just work', 30),
    demoEvent(roomId, {
      type: EventType.RoomMessage,
      sender: MOCHI,
      ts: ts(12),
      content: { msgtype: 'm.notice', body: 'Mochi set the topic.' },
    }),
  ];
};

const seeds = (): RoomSeed[] => [
  {
    roomId: DEMO_ROOM_IDS.cafe,
    name: 'Cat Café',
    isSpace: true,
    topic: 'A Space with voice fully configured.',
    state: (id) => [
      ...spaceChildEvents(id, [
        DEMO_ROOM_IDS.general,
        DEMO_ROOM_IDS.introductions,
        DEMO_ROOM_IDS.lounge,
        DEMO_ROOM_IDS.afk,
      ]),
      // Fully configured voice, bot ID included — the state the app now writes for itself.
      demoEvent(id, {
        type: 'xyz.nekous.voice_server',
        stateKey: '',
        content: {
          url: DEMO_LIVEKIT_URL,
          tokenEndpoint: DEMO_TOKEN_ENDPOINT,
          botUserId: DEMO_BOT_USER_ID,
        },
      }),
      feedPointerEvent(id, DEMO_USER_ID, DEMO_ROOM_IDS.feedYou),
      feedPointerEvent(id, NIBBLES, DEMO_ROOM_IDS.feedNibbles),
      // Report review is on, with a couple of sample reports in its queue (the Reports room below).
      demoEvent(id, { type: 'xyz.nekous.moderation', stateKey: '', content: { review_room: DEMO_ROOM_IDS.review } }),
      // Two events on the Space's calendar (matrix/calendar.ts), one in a text channel, one in voice.
      demoEvent(id, {
        type: 'xyz.nekous.calendar_event',
        stateKey: 'demo-movie-night',
        ts: ts(300),
        content: {
          title: 'Movie night',
          description: 'Bring snacks. We vote on the film at 6:45.',
          start: inDays(2, 19),
          end: inDays(2, 22),
          channel_id: DEMO_ROOM_IDS.general,
        },
      }),
      demoEvent(id, {
        type: 'xyz.nekous.calendar_event',
        stateKey: 'demo-game-night',
        ts: ts(200),
        content: { title: 'Game night', description: '', start: inDays(5, 20), channel_id: DEMO_ROOM_IDS.lounge },
      }),
      demoEvent(id, {
        type: 'xyz.nekous.channel_categories',
        stateKey: '',
        content: {
          categories: [
            { id: 'cat-text', name: 'Text channels', channelIds: [DEMO_ROOM_IDS.general, DEMO_ROOM_IDS.introductions] },
            { id: 'cat-voice', name: 'Voice channels', channelIds: [DEMO_ROOM_IDS.lounge, DEMO_ROOM_IDS.afk] },
          ],
        },
      }),
    ],
  },
  {
    roomId: DEMO_ROOM_IDS.general,
    name: 'general',
    topic: 'Markdown, code blocks, spoilers, reactions and mentions all render here.',
    state: (id) => [
      spaceParentEvent(id, DEMO_ROOM_IDS.cafe),
      // A webhook on this channel (matrix/webhooks.ts); only a hash of its token is ever stored.
      demoEvent(id, { type: 'xyz.nekous.webhook', stateKey: 'demo-deploys', content: { name: 'Deploys', token_sha256: '0'.repeat(64) } }),
    ],
    timeline: GENERAL_TIMELINE,
  },
  {
    roomId: DEMO_ROOM_IDS.introductions,
    name: 'introductions',
    state: (id) => [spaceParentEvent(id, DEMO_ROOM_IDS.cafe)],
    timeline: (id) => [textMessage(id, MOCHI, 'hi! i mostly lurk', 600)],
  },
  {
    // The happy path: bot present, so joining gets all the way to the token request.
    roomId: DEMO_ROOM_IDS.lounge,
    name: 'Lounge',
    voice: true,
    members: [...DEMO_MEMBERS.map((m) => m.userId), DEMO_BOT_USER_ID],
    state: (id) => [
      spaceParentEvent(id, DEMO_ROOM_IDS.cafe),
      demoEvent(id, {
        type: EventType.RoomMember,
        stateKey: DEMO_BOT_USER_ID,
        sender: DEMO_BOT_USER_ID,
        content: { membership: 'join', displayname: 'Purrlor Voice' },
      }),
    ],
  },
  {
    // The channel the voice-bot fix exists for: bot absent, so selecting this exercises
    // ensureVoiceBotInvited + the 409 retry loop rather than a bare 403.
    roomId: DEMO_ROOM_IDS.afk,
    name: 'AFK',
    voice: true,
    state: (id) => [spaceParentEvent(id, DEMO_ROOM_IDS.cafe)],
  },
  {
    roomId: DEMO_ROOM_IDS.arcade,
    name: 'Pixel Arcade',
    isSpace: true,
    topic: 'A Space with no voice server configured at all.',
    members: [DEMO_USER_ID, PIXEL],
    // Pixel posts here too, but this Space isn't listed in the directory, so those posts must
    // stay inside it — the demo's check that the global feed respects an unlisted Space.
    state: (id) => [
      ...spaceChildEvents(id, [DEMO_ROOM_IDS.gaming, DEMO_ROOM_IDS.gameNight]),
      feedPointerEvent(id, PIXEL, DEMO_ROOM_IDS.feedPixel),
    ],
  },
  {
    roomId: DEMO_ROOM_IDS.gaming,
    name: 'gaming',
    members: [DEMO_USER_ID, PIXEL],
    state: (id) => [spaceParentEvent(id, DEMO_ROOM_IDS.arcade)],
    timeline: (id) => [textMessage(id, PIXEL, 'anyone up for something tonight?', 300)],
  },
  {
    // No voice server on this Space — shows the "ask an admin to configure one" branch.
    roomId: DEMO_ROOM_IDS.gameNight,
    name: 'Game Night',
    voice: true,
    members: [DEMO_USER_ID, PIXEL],
    state: (id) => [spaceParentEvent(id, DEMO_ROOM_IDS.arcade)],
  },
  {
    // Cat Café's report review room (matrix/reports.ts): moderators only, never listed as a chat.
    // Two reports waiting, one about a message and one about a post.
    roomId: DEMO_ROOM_IDS.review,
    name: 'Reports',
    roomType: 'xyz.nekous.review_room',
    members: [DEMO_USER_ID, NIBBLES],
    timeline: (id) => [
      demoEvent(id, {
        type: 'xyz.nekous.report',
        sender: NIBBLES,
        ts: ts(60),
        content: {
          report_id: 'demo-report-1',
          space_id: DEMO_ROOM_IDS.cafe,
          room_id: DEMO_ROOM_IDS.general,
          event_id: REPORTED_MESSAGE_ID,
          reported_user: PIXEL,
          reason: 'Posting spoilers with no warning',
          excerpt: 'careful though ||it pegs a weak server on packet crypto||',
          reported_at: ts(62),
          reporter: MOCHI,
        },
      }),
      demoEvent(id, {
        type: 'xyz.nekous.report',
        sender: NIBBLES,
        ts: ts(20),
        content: {
          report_id: 'demo-report-2',
          space_id: DEMO_ROOM_IDS.cafe,
          room_id: DEMO_ROOM_IDS.feedNibbles,
          event_id: REPORTED_POST_ID,
          reported_user: NIBBLES,
          reason: 'Off-topic',
          excerpt: 'movie night friday, bring snacks',
          reported_at: ts(22),
          content_kind: 'post',
          post_id: REPORTED_POST_ID,
          reporter: PIXEL,
        },
      }),
    ],
  },
  // Feed rooms are deliberately NOT space children: they're discovered through their owner's
  // member event, so nothing lists them as channels (matrix/feed.ts).
  {
    roomId: DEMO_ROOM_IDS.feedYou,
    name: "You's posts",
    feed: DEMO_USER_ID,
    members: [DEMO_USER_ID, NIBBLES],
    timeline: (id) => {
      // Someone liked and commented on your post, so Notifications has something to show.
      const post = demoPost(id, DEMO_USER_ID, 'finally got the **voice channels** working', 45);
      const about = { 'm.relates_to': { rel_type: 'm.reference', event_id: post.getId() } };
      return [
        post,
        demoEvent(id, {
          type: EventType.Reaction,
          sender: NIBBLES,
          ts: ts(40),
          content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: post.getId(), key: '❤️' } },
        }),
        demoEvent(id, { type: 'xyz.nekous.comment', sender: NIBBLES, ts: ts(38), content: { body: 'finally!! testing it tonight', ...about } }),
      ];
    },
  },
  {
    roomId: DEMO_ROOM_IDS.feedNibbles,
    name: "Nibbles's posts",
    feed: NIBBLES,
    members: [DEMO_USER_ID, NIBBLES],
    timeline: (id) => [
      demoPost(id, NIBBLES, 'movie night friday, bring snacks', 12, REPORTED_POST_ID),
      demoEvent(id, {
        type: 'xyz.nekous.post',
        sender: NIBBLES,
        ts: ts(20),
        content: {
          body: 'look at these two',
          'xyz.nekous.repost_of': {
            roomId: DEMO_OUTSIDE_SPACE.profileRoomId,
            eventId: LUNA_OWLS_POST.eventId,
            sender: DEMO_OUTSIDE_SPACE.author,
            senderName: DEMO_OUTSIDE_SPACE.authorName,
            origin: { kind: 'global' },
            ts: ts(LUNA_OWLS_POST.minutesAgo),
            body: LUNA_OWLS_POST.body,
            attachments: LUNA_OWLS_POST.attachments,
          },
        },
      }),
      demoPost(id, NIBBLES, 'anyone else up at 3am', 300),
    ],
  },
  {
    roomId: DEMO_ROOM_IDS.feedPixel,
    name: "Pixel's posts",
    feed: PIXEL,
    feedSpace: DEMO_ROOM_IDS.arcade,
    members: [DEMO_USER_ID, PIXEL],
    timeline: (id) => [demoPost(id, PIXEL, 'arcade members only: bracket for saturday is up', 30)],
  },
  {
    roomId: DEMO_ROOM_IDS.dmNibbles,
    name: 'Nibbles',
    members: [DEMO_USER_ID, NIBBLES],
    timeline: (id) => [
      textMessage(id, NIBBLES, 'did the file picker thing ever get fixed?', 20),
      textMessage(id, DEMO_USER_ID, 'yep — it was escaping to the modal overlay', 18),
    ],
  },
  {
    roomId: DEMO_ROOM_IDS.groupChat,
    name: 'Weekend Plans',
    members: [DEMO_USER_ID, NIBBLES, PIXEL],
    timeline: (id) => [textMessage(id, PIXEL, 'saturday?', 400)],
  },
];

/** Builds every demo room. Called once, from demoClient.ts, with the fake client to bind to. */
// ---------------------------------------------------------------------------
// The global feed's world (matrix/globalFeed.ts)
// ---------------------------------------------------------------------------

/**
 * A public Space you have NOT joined. It only exists "on the server": the demo client answers the
 * directory, `/state`, and `/messages` calls for it, but there's no Room object for it, exactly
 * like a real Space you've never been in. It's what shows the global feed reaching past your own
 * Spaces.
 */
export const DEMO_OUTSIDE_SPACE = {
  roomId: `!night-owls:${DEMO_SERVER_NAME}`,
  name: 'Night Owls',
  topic: 'Late-night artists and insomniacs.',
  feedRoomId: `!feed-luna:${DEMO_SERVER_NAME}`,
  author: `@luna:${DEMO_SERVER_NAME}`,
  authorName: 'Luna',
  /** Luna's profile feed — her Global posts (profileFeed.ts). */
  profileRoomId: `!profile-luna:${DEMO_SERVER_NAME}`,
} as const;

/** Demo media lives in public/demo-media; the demo client maps these mxc URLs onto it. */
export const DEMO_MEDIA_PREFIX = `mxc://${DEMO_SERVER_NAME}/media-`;

function demoImage(file: string, size: number, w: number, h: number) {
  return { kind: 'image', url: `${DEMO_MEDIA_PREFIX}${file}`, name: file, info: { mimetype: 'image/webp', size, w, h } };
}

const LUNA_OWLS_POST = {
  eventId: '$demo-luna-global-0',
  body: 'New piece: two owls and a moon. Painted most of it between 2 and 4am, as is tradition.',
  attachments: [demoImage('owls.webp', 10984, 960, 640)],
  minutesAgo: 8,
};

/**
 * The fake homeserver's public directory. Cat Café is public (listed, world-readable); Pixel
 * Arcade is deliberately *not* listed, so the demo shows an unlisted Space's posts staying out
 * of the global feed; Night Owls is public and unjoined.
 */
export function demoPublicDirectory() {
  return [
    {
      room_id: DEMO_ROOM_IDS.cafe,
      name: 'Cat Café',
      topic: 'A Space with voice fully configured.',
      num_joined_members: DEMO_MEMBERS.length,
      world_readable: true,
      guest_can_join: false,
      room_type: RoomType.Space,
    },
    {
      room_id: DEMO_OUTSIDE_SPACE.profileRoomId,
      name: DEMO_OUTSIDE_SPACE.authorName,
      num_joined_members: 1,
      world_readable: true,
      guest_can_join: false,
      room_type: 'xyz.nekous.profile',
    },
    {
      room_id: DEMO_OUTSIDE_SPACE.roomId,
      name: DEMO_OUTSIDE_SPACE.name,
      topic: DEMO_OUTSIDE_SPACE.topic,
      num_joined_members: 1,
      world_readable: true,
      guest_can_join: false,
      room_type: RoomType.Space,
    },
  ];
}

/** Raw `/state` for the unjoined Space: one member, publishing her feed room. */
export function demoOutsideSpaceState() {
  return [
    {
      type: EventType.RoomMember,
      state_key: DEMO_OUTSIDE_SPACE.author,
      sender: DEMO_OUTSIDE_SPACE.author,
      room_id: DEMO_OUTSIDE_SPACE.roomId,
      content: {
        membership: 'join',
        displayname: DEMO_OUTSIDE_SPACE.authorName,
        'xyz.nekous.feed_room': DEMO_OUTSIDE_SPACE.feedRoomId,
      },
    },
  ];
}

/** Raw `/messages` for Luna's feed in Night Owls, newest first like a backwards page. */
export function demoOutsideFeedEvents() {
  const posts: { body: string; minutesAgo: number; attachments?: unknown[] }[] = [
    { body: 'Finished the owl series at 4am. Worth it.', minutesAgo: 25 },
    { body: 'Sketching from the windowsill tonight.', minutesAgo: 95, attachments: [demoImage('windowsill.webp', 7160, 720, 720)] },
    { body: 'Open sketch stream tonight if anyone wants company while they draw.', minutesAgo: 190 },
  ];
  return posts.map(({ body, minutesAgo, attachments }, index) => ({
    type: 'xyz.nekous.post',
    event_id: `$demo-luna-post-${index}`,
    sender: DEMO_OUTSIDE_SPACE.author,
    room_id: DEMO_OUTSIDE_SPACE.feedRoomId,
    origin_server_ts: ts(minutesAgo),
    content: { body, ...(attachments && { 'xyz.nekous.attachments': attachments }) },
  }));
}

/** Raw `/state` for Luna's profile room: created by her, marked as her profile feed. */
export function demoProfileRoomState() {
  const roomId = DEMO_OUTSIDE_SPACE.profileRoomId;
  const luna = DEMO_OUTSIDE_SPACE.author;
  return [
    { type: EventType.RoomCreate, state_key: '', sender: luna, room_id: roomId, content: { creator: luna, type: 'xyz.nekous.profile' } },
    { type: 'xyz.nekous.feed', state_key: '', sender: luna, room_id: roomId, content: { owner: luna, profile: true } },
    { type: EventType.RoomMember, state_key: luna, sender: luna, room_id: roomId, content: { membership: 'join', displayname: 'Luna' } },
  ];
}

/** Raw `/messages` for Luna's profile room: one Global post, with an image. */
export function demoProfileRoomEvents() {
  return [
    {
      type: 'xyz.nekous.post',
      event_id: LUNA_OWLS_POST.eventId,
      sender: DEMO_OUTSIDE_SPACE.author,
      room_id: DEMO_OUTSIDE_SPACE.profileRoomId,
      origin_server_ts: ts(LUNA_OWLS_POST.minutesAgo),
      content: { body: LUNA_OWLS_POST.body, 'xyz.nekous.attachments': LUNA_OWLS_POST.attachments },
    },
  ];
}

export function buildDemoRooms(client: MatrixClient): Room[] {
  return seeds().map((seed) => buildRoom(client, seed));
}
