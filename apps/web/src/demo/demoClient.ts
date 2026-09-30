import { TypedEventEmitter } from 'matrix-js-sdk/lib/models/typed-event-emitter';
import {
  ClientEvent,
  EventType,
  MatrixEvent,
  RoomEvent,
  RoomStateEvent,
  User,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { DEMO_BOT_USER_ID, DEMO_SERVER_NAME, DEMO_USER_ID } from './demoMode';
import {
  buildDemoRooms,
  DEMO_MEMBERS,
  DEMO_OUTSIDE_SPACE,
  DEMO_ROOM_IDS,
  demoEvent,
  demoOutsideFeedEvents,
  demoOutsideSpaceState,
  demoProfileRoomEvents,
  demoProfileRoomState,
  demoPublicDirectory,
  DEMO_MEDIA_PREFIX,
} from './demoWorld';

/**
 * A stand-in for `MatrixClient` covering exactly the surface this app actually uses — see the
 * method list below against `grep -o 'mx\.[a-zA-Z]*'` over src/.
 *
 * Reads are served from real `Room` objects (demoWorld.ts). Writes are applied to those same
 * objects and then announced with the SDK's own events, so the UI updates live: sending a
 * message really does append to the timeline, and saving Space Settings really does rewrite the
 * state event the settings form reads back. Nothing is persisted — a reload restores the
 * starting world.
 *
 * Anything genuinely unsupportable offline (E2EE, device verification, server-side search,
 * pushers) resolves to a benign empty value rather than throwing, so a screen that touches one
 * renders its empty state instead of crashing the app.
 */

type Listener = (...args: unknown[]) => void;

function localPart(userId: string): string {
  return userId.slice(1).split(':')[0];
}

function displayNameFor(userId: string): string {
  if (userId === DEMO_OUTSIDE_SPACE.author) return DEMO_OUTSIDE_SPACE.authorName;
  return DEMO_MEMBERS.find((m) => m.userId === userId)?.name ?? localPart(userId);
}

export function createDemoClient(): MatrixClient {
  // The SDK's own emitter, not Node's: Room objects re-emit through their client, and the real
  // one is a TypedEventEmitter — matching it keeps that wiring identical to production.
  const emitter = new TypedEventEmitter<string, Record<string, Listener>>();
  emitter.setMaxListeners(0);

  let rooms: Room[] = [];
  const accountData = new Map<string, MatrixEvent>();

  const getRoom = (roomId: string): Room | null => rooms.find((r) => r.roomId === roomId) ?? null;

  const emit = (event: string, ...args: unknown[]) => {
    (emitter as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(event, ...args);
  };

  /** Appends a timeline event and announces it exactly as a real sync would. */
  const appendToTimeline = (roomId: string, event: MatrixEvent): string => {
    const room = getRoom(roomId);
    if (!room) return event.getId() ?? '';
    room.addLiveEvents([event], { addToState: false } as never);
    emit(RoomEvent.Timeline, event, room, false, false, room.getLiveTimeline());
    return event.getId() ?? '';
  };

  /** Applies a state event and announces it, so state-driven hooks re-read. */
  const applyStateEvent = (roomId: string, type: string, content: object, stateKey: string): void => {
    const room = getRoom(roomId);
    if (!room) return;
    const event = demoEvent(roomId, { type, stateKey, content: content as Record<string, unknown> });
    room.currentState.setStateEvents([event]);
    room.recalculate();
    emit(RoomStateEvent.Events, event, room.currentState, null);
    emit(ClientEvent.Room, room);
  };

  const client = emitter as unknown as MatrixClient & Record<string, unknown>;

  // Push rules: none to start, kept in memory. Enough for what reads and changes them (keyword
  // notifications, notification levels); without them, Account Settings crashed in the demo.
  type DemoRule = { rule_id: string; default: boolean; enabled: boolean; [key: string]: unknown };
  const pushRules: { global: Record<string, DemoRule[]> } = {
    global: { override: [], content: [], room: [], sender: [], underride: [] },
  };

  Object.assign(client, {
    // --- identity -------------------------------------------------------------------------
    getUserId: () => DEMO_USER_ID,
    getSafeUserId: () => DEMO_USER_ID,
    getDeviceId: () => 'DEMODEVICE',
    getAccessToken: () => 'demo-access-token',
    getDomain: () => DEMO_SERVER_NAME,
    getHomeserverUrl: () => `https://${DEMO_SERVER_NAME}`,
    credentials: { userId: DEMO_USER_ID },
    isGuest: () => false,

    // --- internals real Room objects reach for ---------------------------------------------
    store: { getPendingEvents: async () => [], setPendingEvents: async () => {} },
    getEventMapper: () => (plain: object) => new MatrixEvent(plain as never),
    isInitialSyncComplete: () => true,
    getSyncState: () => 'SYNCING',
    supportsThreads: () => true,
    decryptEventIfNeeded: async () => {},
    isRoomEncrypted: () => false,
    // No crypto at all in demo mode — every caller of this already handles `undefined` (that's
    // the same thing a client built without E2EE support returns).
    getCrypto: () => undefined,
    secretStorage: { hasKey: async () => false },
    initRustCrypto: async () => {},
    clearStores: async () => {},

    // --- rooms ------------------------------------------------------------------------------
    getRooms: () => rooms,
    getRoom,
    getVisibleRooms: () => rooms,

    // --- users / profiles --------------------------------------------------------------------
    getUser: (userId: string) => {
      const user = new User(userId);
      user.displayName = displayNameFor(userId);
      user.presence = userId === DEMO_USER_ID ? 'online' : 'unavailable';
      return user;
    },
    // Everyone the demo knows of — who a Global post's @mention autocomplete offers.
    getUsers: () =>
      [...DEMO_MEMBERS.map((m) => m.userId), DEMO_OUTSIDE_SPACE.author].map((userId) => {
        const user = new User(userId);
        user.displayName = displayNameFor(userId);
        return user;
      }),
    getProfileInfo: async (userId: string) => ({ displayname: displayNameFor(userId) }),
    getPresence: async () => ({ presence: 'online' }),
    setPresence: async () => {},
    setDisplayName: async () => {},
    setAvatarUrl: async () => {},
    getExtendedProfile: async () => ({}),
    doesServerSupportExtendedProfiles: async () => false,
    setExtendedProfileProperty: async () => {},
    deleteExtendedProfileProperty: async () => {},

    // --- sending -----------------------------------------------------------------------------
    sendEvent: async (roomId: string, ...rest: unknown[]) => {
      // Real signature is overloaded on whether a threadId is passed; normalise both shapes.
      const [maybeThreadId, maybeType, maybeContent] = rest;
      const isThreaded = typeof maybeThreadId === 'string' || maybeThreadId === null;
      const type = (isThreaded ? maybeType : maybeThreadId) as string;
      const content = (isThreaded ? maybeContent : maybeType) as Record<string, unknown>;
      return { event_id: appendToTimeline(roomId, demoEvent(roomId, { type, content })) };
    },
    sendMessage: async (roomId: string, ...rest: unknown[]) => {
      const content = (rest.find((a) => typeof a === 'object' && a !== null) ?? {}) as Record<string, unknown>;
      return {
        event_id: appendToTimeline(roomId, demoEvent(roomId, { type: EventType.RoomMessage, content })),
      };
    },
    sendTextMessage: async (roomId: string, body: string) => ({
      event_id: appendToTimeline(
        roomId,
        demoEvent(roomId, { type: EventType.RoomMessage, content: { msgtype: 'm.text', body } })
      ),
    }),
    sendStickerMessage: async (roomId: string, ...rest: unknown[]) => {
      const content = (rest.find((a) => typeof a === 'object' && a !== null) ?? {}) as Record<string, unknown>;
      return { event_id: appendToTimeline(roomId, demoEvent(roomId, { type: EventType.Sticker, content })) };
    },
    sendStateEvent: async (roomId: string, type: string, content: object, stateKey = '') => {
      applyStateEvent(roomId, type, content, stateKey);
      return { event_id: `$demo-state-${Date.now()}` };
    },
    redactEvent: async (roomId: string, eventId: string) => {
      const room = getRoom(roomId);
      const target = room?.findEventById(eventId);
      if (room && target) {
        target.makeRedacted(
          demoEvent(roomId, { type: EventType.RoomRedaction, content: {} }),
          room
        );
        emit(RoomEvent.Timeline, target, room, false, false, room.getLiveTimeline());
      }
      return { event_id: `$demo-redact-${Date.now()}` };
    },
    sendTyping: async () => {},
    sendReadReceipt: async () => {},
    setRoomTopic: async (roomId: string, topic: string) => {
      applyStateEvent(roomId, EventType.RoomTopic, { topic }, '');
    },

    // --- membership / moderation ---------------------------------------------------------------
    invite: async (roomId: string, userId: string) => {
      applyStateEvent(
        roomId,
        EventType.RoomMember,
        { membership: 'invite', displayname: displayNameFor(userId) },
        userId
      );
      // The demo's service bot behaves like the real one: it accepts immediately (see
      // services/token-server/src/membership.ts), which is what lets a voice channel it
      // wasn't in become joinable a moment after the invite.
      if (userId === DEMO_BOT_USER_ID) {
        setTimeout(() => {
          applyStateEvent(
            roomId,
            EventType.RoomMember,
            { membership: 'join', displayname: 'Purrlor Voice' },
            userId
          );
        }, 900);
      }
    },
    kick: async () => {},
    ban: async () => {},
    unban: async () => {},
    setPowerLevel: async () => {},
    leave: async () => {},
    joinRoom: async (roomIdOrAlias: string) => getRoom(roomIdOrAlias) ?? rooms[0],
    getIgnoredUsers: () => [],
    setIgnoredUsers: async () => {},

    // --- creation ---------------------------------------------------------------------------
    createRoom: async () => ({ room_id: `!demo-created-${Date.now()}:${DEMO_SERVER_NAME}` }),

    // --- account data --------------------------------------------------------------------------
    getAccountData: (type: string) => accountData.get(type),
    setAccountData: async (type: string, content: object) => {
      const event = new MatrixEvent({ type, content: content as never });
      accountData.set(type, event);
      emit(ClientEvent.AccountData, event);
    },

    // --- media -------------------------------------------------------------------------------
    // Demo avatars are all generated locally by <Avatar> from the display name, so nothing here
    // ever needs a real mxc:// round trip.
    // Demo posts' media are real files under public/demo-media (see DEMO_MEDIA_PREFIX).
    mxcUrlToHttp: (mxc: string) =>
      mxc.startsWith(DEMO_MEDIA_PREFIX) ? `/demo-media/${mxc.slice(DEMO_MEDIA_PREFIX.length)}` : null,
    getMediaConfig: async () => ({ 'm.upload.size': 50 * 1024 * 1024 }),
    uploadContent: async () => ({ content_uri: `mxc://${DEMO_SERVER_NAME}/demo-upload` }),

    // --- directory / discovery ------------------------------------------------------------------
    publicRooms: async () => {
      const chunk = demoPublicDirectory();
      return { chunk, total_room_count_estimate: chunk.length };
    },
    // Agrees with the directory above, so Space Settings shows the same answer the feeds use.
    getRoomDirectoryVisibility: async (roomId: string) => ({
      visibility: demoPublicDirectory().some((entry) => entry.room_id === roomId) ? 'public' : 'private',
    }),
    // Posts' likes and comments (matrix/postInteractions.ts): the demo world has none yet.
    fetchRelations: async () => ({ chunk: [] }),
    // The two reads the global feed makes without joining (matrix/globalFeed.ts). A room the
    // demo has as a Room answers from its own state/timeline; the unjoined public Space answers
    // from its fixed fixtures; anything else is refused the way a server refuses a non-member.
    roomState: async (roomId: string) => {
      const room = getRoom(roomId);
      if (room) {
        return [...room.currentState.events.values()].flatMap((byKey) => [...byKey.values()].map((event) => event.event));
      }
      if (roomId === DEMO_OUTSIDE_SPACE.roomId) return demoOutsideSpaceState();
      if (roomId === DEMO_OUTSIDE_SPACE.profileRoomId) return demoProfileRoomState();
      throw new Error('M_FORBIDDEN');
    },
    createMessagesRequest: async (roomId: string) => {
      const room = getRoom(roomId);
      const chunk = room
        ? [...room.getLiveTimeline().getEvents()].reverse().map((event) => event.event)
        : roomId === DEMO_OUTSIDE_SPACE.feedRoomId
          ? demoOutsideFeedEvents()
          : roomId === DEMO_OUTSIDE_SPACE.profileRoomId
            ? demoProfileRoomEvents()
            : [];
      // One page is the whole history here, so no `end` token: "nothing older".
      return { chunk, start: 'demo' };
    },
    getRoomHierarchy: async () => ({ rooms: [] }),
    getUrlPreview: async () => ({}),

    // --- capability probes -----------------------------------------------------------------------
    isVersionSupported: async () => true,
    doesServerSupportUnstableFeature: async () => false,

    // --- things with no offline meaning -------------------------------------------------------------
    searchRoomEvents: async () => ({ results: [], count: 0, next_batch: undefined, highlights: [] }),
    relations: async () => ({ events: [] }),
    // `/messages`, read from the room in memory, is the one raw endpoint the demo answers: how
    // Notifications reads likes, comments and follows from your feed rooms (matrix/activity.ts).
    http: {
      authedRequest: async (method: string, path: string, query: Record<string, string> = {}) => {
        const match = method === 'GET' ? /^\/rooms\/([^/]+)\/messages$/.exec(path) : null;
        const room = match ? getRoom(decodeURIComponent(match[1])) : null;
        if (!room) throw Object.assign(new Error('M_UNRECOGNIZED'), { httpStatus: 404 });
        const types = query.filter ? (JSON.parse(query.filter) as { types?: string[] }).types : undefined;
        const chunk = room
          .getLiveTimeline()
          .getEvents()
          .map((event) => event.event)
          .filter((event) => !types || types.includes(event.type ?? ''))
          .reverse()
          .slice(0, Number(query.limit ?? 10));
        return { chunk };
      },
    },
    // Reposts check their original against this (matrix/repostCheck.ts).
    fetchRoomEvent: async (roomId: string, eventId: string) => {
      const room = getRoom(roomId);
      const events = room
        ? room.getLiveTimeline().getEvents().map((event) => event.event)
        : roomId === DEMO_OUTSIDE_SPACE.feedRoomId
          ? demoOutsideFeedEvents()
          : roomId === DEMO_OUTSIDE_SPACE.profileRoomId
            ? demoProfileRoomEvents()
            : [];
      const found = events.find((event) => event.event_id === eventId);
      if (!found) throw Object.assign(new Error('M_NOT_FOUND'), { httpStatus: 404 });
      return found;
    },
    scrollback: async (room: Room) => room,
    getPushActionsForEvent: () => ({ notify: false, tweaks: {} }),
    getDevices: async () => ({ devices: [] }),
    setDeviceDetails: async () => {},
    deleteDevice: async () => {},
    setPusher: async () => {},
    removePusher: async () => {},
    pushRules,
    getPushRules: async () => structuredClone(pushRules),
    addPushRule: async (_scope: string, kind: string, ruleId: string, body: Record<string, unknown>) => {
      const list = (pushRules.global[kind] ??= []);
      const rule = { ...body, rule_id: ruleId, default: false, enabled: true };
      const at = list.findIndex((r) => r.rule_id === ruleId);
      if (at >= 0) list[at] = rule;
      else list.unshift(rule); // a new rule goes first, as on a homeserver
      return {};
    },
    deletePushRule: async (_scope: string, kind: string, ruleId: string) => {
      const list = pushRules.global[kind] ?? [];
      const at = list.findIndex((r) => r.rule_id === ruleId);
      if (at < 0) throw Object.assign(new Error('Push rule not found'), { errcode: 'M_NOT_FOUND', httpStatus: 404 });
      list.splice(at, 1);
      return {};
    },
    getOpenIdToken: async () => ({
      access_token: 'demo-openid-token',
      token_type: 'Bearer',
      matrix_server_name: DEMO_SERVER_NAME,
      expires_in: 3600,
    }),

    // --- lifecycle ---------------------------------------------------------------------------------
    startClient: async () => {},
    stopClient: () => {},
    logout: async () => {},
  });

  rooms = buildDemoRooms(client as MatrixClient);

  // What MentionInboxCollector would have logged had you been online for the sample world's
  // mentions of you, so Notifications has them too.
  const mentions = rooms.flatMap((room) =>
    room
      .getLiveTimeline()
      .getEvents()
      .filter((event) => event.getSender() !== DEMO_USER_ID && event.getContent()['m.mentions']?.user_ids?.includes(DEMO_USER_ID))
      .map((event) => ({ roomId: room.roomId, eventId: event.getId(), mentionedAt: event.getTs() }))
  );
  // Your feed room in Cat Café, as creating it would have recorded (matrix/feed.ts) — where
  // Notifications looks for likes and comments on your posts.
  accountData.set(
    'xyz.nekous.feed_rooms',
    new MatrixEvent({ type: 'xyz.nekous.feed_rooms', content: { [DEMO_ROOM_IDS.cafe]: DEMO_ROOM_IDS.feedYou } })
  );
  accountData.set('xyz.nekous.mention_inbox', new MatrixEvent({ type: 'xyz.nekous.mention_inbox', content: { items: mentions } }));

  return client as MatrixClient;
}
