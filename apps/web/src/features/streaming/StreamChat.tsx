import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Direction, MatrixEvent, RoomEvent, type MatrixClient } from 'matrix-js-sdk';
import { Avatar } from '../../components/Avatar';
import { serverOfUserId } from '../../matrix/homeServer';
import { fetchChat, type ChatMessage, type PublicStream } from '../../matrix/liveStream';

const MAX_SHOWN = 200;
const POLL_MS = 3_000;

type Line = ChatMessage & { name: string; avatarUrl?: string };

/**
 * A stream's chat (docs/streaming.md, "Chat"). Signed in, it's the stream's Matrix room, joined
 * while the chat is open and left after. Signed out, it's read through the stream's server every
 * 3 s, with a way to sign in to talk. Plain text either way; once the stream ends the room is
 * read-only and the chat says so.
 */
export function StreamChat({ base, stream, mx, onSignIn }: { base: string; stream: PublicStream; mx?: MatrixClient; onSignIn?: () => void }) {
  if (!stream.chatRoom) {
    return (
      <aside className="nu-stream-chat nu-stream-chat--empty" data-nu-role="stream-chat">
        <p>This stream has no chat.</p>
      </aside>
    );
  }
  return mx ? (
    <MatrixChat stream={stream} roomId={stream.chatRoom} mx={mx} />
  ) : (
    <ReadOnlyChat base={base} stream={stream} onSignIn={onSignIn} />
  );
}

function ChatLines({ lines }: { lines: Line[] }) {
  const listRef = useRef<HTMLOListElement>(null);
  const stuck = useRef(true);
  useEffect(() => {
    const list = listRef.current;
    if (list && stuck.current) list.scrollTop = list.scrollHeight;
  }, [lines]);
  return (
    <ol
      ref={listRef}
      className="nu-stream-chat__lines"
      data-nu-role="stream-chat-lines"
      onScroll={(event) => {
        const el = event.currentTarget;
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {lines.length === 0 && <li className="nu-stream-chat__quiet">No messages yet.</li>}
      {lines.map((line) => (
        <li key={line.id} className="nu-stream-chat__line" data-nu-role="stream-chat-line">
          <Avatar name={line.name} mxcUrl={line.avatarUrl} size={20} />
          <span className="nu-stream-chat__name">{line.name}</span>
          <span className="nu-stream-chat__body">{line.body}</span>
        </li>
      ))}
    </ol>
  );
}

const nameOf = (userId: string) => userId.replace(/^@/, '').replace(/:.*$/, '');

function toLine(mx: MatrixClient, event: MatrixEvent): Line | undefined {
  if (event.getType() !== 'm.room.message' || event.isRedacted()) return undefined;
  const content = event.getContent<{ msgtype?: string; body?: unknown; 'm.relates_to'?: { rel_type?: string } }>();
  if ((content.msgtype !== 'm.text' && content.msgtype !== 'm.emote') || typeof content.body !== 'string') return undefined;
  if (content['m.relates_to']?.rel_type === 'm.replace') return undefined;
  const sender = event.getSender() ?? '';
  const member = mx.getRoom(event.getRoomId())?.getMember(sender);
  return {
    id: event.getId() ?? `${sender}-${event.getTs()}`,
    ts: event.getTs(),
    sender,
    body: (content.msgtype === 'm.emote' ? `* ${content.body}` : content.body).slice(0, 2000),
    name: member?.name || nameOf(sender),
    avatarUrl: member?.getMxcAvatarUrl() ?? undefined,
  };
}

function MatrixChat({ stream, roomId, mx }: { stream: PublicStream; roomId: string; mx: MatrixClient }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState('');
  const ended = stream.state === 'ended';

  useEffect(() => {
    let cancelled = false;
    const wasIn = mx.getRoom(roomId)?.getMyMembership() === 'join';
    // What was said before you opened it: a room just joined syncs only from the join, so the
    // recent history is read from the server once, and live messages added to it.
    let history: Line[] = [];
    const read = () => {
      const events = mx.getRoom(roomId)?.getLiveTimeline().getEvents() ?? [];
      const live = events.flatMap((event) => toLine(mx, event) ?? []);
      const redacted = new Set(events.filter((event) => event.isRedacted()).map((event) => event.getId()));
      const byId = new Map([...history, ...live].filter((line) => !redacted.has(line.id)).map((line) => [line.id, line]));
      if (!cancelled) setLines([...byId.values()].sort((a, b) => a.ts - b.ts).slice(-MAX_SHOWN));
    };
    const onTimeline = (event: MatrixEvent) => {
      if (event.getRoomId() === roomId) read();
    };
    mx.on(RoomEvent.Timeline, onTimeline);
    mx.on(RoomEvent.Redaction, onTimeline);
    (wasIn ? Promise.resolve() : mx.joinRoom(roomId, { viaServers: [serverOfUserId(stream.owner)] }))
      .then(async () => {
        if (cancelled) return;
        setJoined(true);
        const page = await mx.createMessagesRequest(roomId, null, 100, Direction.Backward).catch(() => undefined);
        history = (page?.chunk ?? []).flatMap((raw) => toLine(mx, new MatrixEvent(raw)) ?? []);
        read();
      })
      .catch(() => {
        if (!cancelled) setError('Couldn’t open the chat.');
      });
    return () => {
      cancelled = true;
      mx.off(RoomEvent.Timeline, onTimeline);
      mx.off(RoomEvent.Redaction, onTimeline);
      // Joined only to watch: left again, so it doesn't follow you around. The streamer stays.
      if (!wasIn && mx.getUserId() !== stream.owner) void mx.leave(roomId).catch(() => undefined);
    };
  }, [mx, roomId, stream.owner]);

  const send = (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    mx.sendMessage(roomId, { msgtype: 'm.text', body } as never).catch(() => setError('That message didn’t send.'));
  };

  return (
    <aside className="nu-stream-chat" data-nu-role="stream-chat">
      <h2 className="nu-stream-chat__title">Live chat</h2>
      <ChatLines lines={lines} />
      {error && <p className="nu-stream-chat__error">{error}</p>}
      {ended ? (
        <p className="nu-stream-chat__closed">The stream has ended, so the chat is closed.</p>
      ) : (
        <form className="nu-stream-chat__composer" onSubmit={send}>
          <input
            type="text"
            value={draft}
            maxLength={500}
            disabled={!joined}
            placeholder={joined ? 'Say something…' : 'Opening the chat…'}
            aria-label="Chat message"
            data-nu-role="stream-chat-input"
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="nu-button nu-button--primary" disabled={!joined || !draft.trim()} data-nu-role="stream-chat-send">
            Send
          </button>
        </form>
      )}
    </aside>
  );
}

function ReadOnlyChat({ base, stream, onSignIn }: { base: string; stream: PublicStream; onSignIn?: () => void }) {
  const [lines, setLines] = useState<Line[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let last = 0;
    const read = () => {
      void fetchChat(base, stream.id, last || undefined)
        .then(({ messages, avatars }) => {
          if (cancelled || messages.length === 0) return;
          last = messages[messages.length - 1].ts;
          const fresh = messages.map((m) => ({ ...m, name: nameOf(m.sender), avatarUrl: avatars[m.sender] }));
          setLines((prev) => {
            const seen = new Set(prev.map((line) => line.id));
            return [...prev, ...fresh.filter((line) => !seen.has(line.id))].slice(-MAX_SHOWN);
          });
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled && stream.state === 'live') timer = window.setTimeout(read, POLL_MS);
        });
    };
    read();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [base, stream.id, stream.state]);

  return (
    <aside className="nu-stream-chat" data-nu-role="stream-chat">
      <h2 className="nu-stream-chat__title">Live chat</h2>
      <ChatLines lines={lines} />
      <p className="nu-stream-chat__closed">
        {onSignIn ? (
          <button type="button" className="nu-button nu-button--secondary" data-nu-role="stream-chat-sign-in" onClick={onSignIn}>
            Sign in to chat
          </button>
        ) : (
          'Sign in to chat.'
        )}
      </p>
    </aside>
  );
}
