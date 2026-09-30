import {
  M_POLL_END,
  M_POLL_KIND_DISCLOSED,
  M_POLL_KIND_UNDISCLOSED,
  M_POLL_RESPONSE,
  M_POLL_START,
  M_TEXT,
  REFERENCE_RELATION,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { canRedactEvent } from './permissions';
import type { PollAnswerDef, PollDefinition, PollKind } from './pollTally';

/**
 * MSC3381 polls, interoperable with Element: this module sends and reads the unstable event
 * types Element sends today (`org.matrix.msc3381.poll.start` etc — what `M_POLL_START.name` and
 * friends resolve to, since `UnstableValue` prioritizes the unstable name), while tolerating the
 * stable `m.poll.*` names on read via `.matches()`/`.findIn()`. Every event also carries an
 * `org.matrix.msc1767.text` (`M_TEXT.name`) fallback body, for clients with no poll support at
 * all. The wire shapes here mirror matrix-js-sdk's own extensible_events_v1 PollStartEvent/
 * PollResponseEvent/PollEndEvent classes (not used directly — they live at a deep, non-exported
 * import path and validate strictly in ways that don't suit tolerant reading of someone else's
 * possibly-malformed event); tallying itself lives in the dependency-free pollTally.ts.
 */

function extractText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const text = M_TEXT.findIn<string>(value as Record<string, unknown>);
  return typeof text === 'string' ? text : undefined;
}

export function isPollStartEvent(event: MatrixEvent): boolean {
  return M_POLL_START.matches(event.getType());
}

export function isPollResponseEvent(event: MatrixEvent): boolean {
  return M_POLL_RESPONSE.matches(event.getType());
}

export function isPollEndEvent(event: MatrixEvent): boolean {
  return M_POLL_END.matches(event.getType());
}

/** Reads a poll's fixed shape (question/answers/kind/max selections) off its `m.poll.start`
 *  event. Returns null for anything that isn't a well-formed poll start — malformed content from
 *  a buggy or malicious sender shouldn't crash the timeline, just decline to render as a poll. */
export function parsePollStart(event: MatrixEvent): PollDefinition | null {
  if (!isPollStartEvent(event)) return null;
  const content = event.getContent();
  const poll = M_POLL_START.findIn<Record<string, unknown>>(content);
  if (!poll) return null;

  const question = extractText(poll.question);
  if (!question) return null;

  const rawAnswers = Array.isArray(poll.answers) ? poll.answers : [];
  const answers: PollAnswerDef[] = rawAnswers
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string')
    .slice(0, 20)
    .map((a) => ({ id: a.id as string, text: extractText(a) ?? '' }));
  if (answers.length === 0) return null;

  const kind: PollKind = M_POLL_KIND_DISCLOSED.matches(poll.kind as string) ? 'disclosed' : 'undisclosed';
  const rawMax = poll.max_selections;
  const maxSelections = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : 1;

  return { question, answers, kind, maxSelections: Math.min(maxSelections, answers.length) };
}

function parseReferenceRelation(content: Record<string, unknown>): string | null {
  const relatesTo = content['m.relates_to'] as { rel_type?: unknown; event_id?: unknown } | undefined;
  if (!relatesTo || !REFERENCE_RELATION.matches(relatesTo.rel_type as string) || typeof relatesTo.event_id !== 'string') {
    return null;
  }
  return relatesTo.event_id;
}

/** A response's raw target + selections — responses relate to their poll via an `m.reference`
 *  relation (MSC3381 predates the more general `rel_type`-per-event-type story). */
export function parsePollResponse(event: MatrixEvent): { pollEventId: string; answerIds: string[] } | null {
  if (!isPollResponseEvent(event)) return null;
  const content = event.getContent();
  const pollEventId = parseReferenceRelation(content);
  if (!pollEventId) return null;
  const response = M_POLL_RESPONSE.findIn<{ answers?: unknown }>(content);
  const answerIds = Array.isArray(response?.answers) ? response.answers.filter((a): a is string => typeof a === 'string') : [];
  return { pollEventId, answerIds };
}

export function parsePollEnd(event: MatrixEvent): { pollEventId: string } | null {
  if (!isPollEndEvent(event)) return null;
  const pollEventId = parseReferenceRelation(event.getContent());
  return pollEventId ? { pollEventId } : null;
}

export type PollCreateParams = {
  question: string;
  /** 2–20 plain-text answers — enforced here, not just by the composer's modal. */
  answers: string[];
  kind: PollKind;
  /** 1 = single choice. Clamped to [1, answers.length]. */
  maxSelections: number;
};

/** Short, collision-resistant enough for answer ids within one poll (they only need to be unique
 *  inside a single m.poll.start event, not globally). */
function makeAnswerId(index: number): string {
  return `a${index}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Sends a new poll's `m.poll.start` event, including the `org.matrix.msc1767.text` fallback
 *  body (question + numbered answers) for clients without poll support. Returns the new event's
 *  ID — votes and the eventual close both reference it. */
export async function createPoll(mx: MatrixClient, roomId: string, params: PollCreateParams): Promise<string> {
  const question = params.question.trim();
  const answers = params.answers.map((a) => a.trim()).filter(Boolean);
  if (!question) throw new Error('A poll needs a question');
  if (answers.length < 2) throw new Error('A poll needs at least 2 answers');
  if (answers.length > 20) throw new Error('A poll can have at most 20 answers');
  const maxSelections = Math.max(1, Math.min(Math.floor(params.maxSelections) || 1, answers.length));
  const kindValue = (params.kind === 'disclosed' ? M_POLL_KIND_DISCLOSED : M_POLL_KIND_UNDISCLOSED).name;

  const content = {
    [M_POLL_START.name]: {
      question: { [M_TEXT.name]: question },
      kind: kindValue,
      max_selections: maxSelections,
      answers: answers.map((text, i) => ({ id: makeAnswerId(i), [M_TEXT.name]: text })),
    },
    [M_TEXT.name]: `${question}\n${answers.map((a, i) => `${i + 1}. ${a}`).join('\n')}`,
  };
  // TimelineEvents only types a handful of built-in/extensible event shapes — same cast this
  // codebase already uses for every other custom event type (see emotes.ts, feed.ts).
  const res = await mx.sendEvent(roomId, M_POLL_START.name, content as any);
  return res.event_id;
}

/** Casts (or changes) this user's vote — a plain new `m.poll.response` event, since Matrix has no
 *  edit story for votes; `pollTally`'s latest-vote-wins rule is what makes a revote work. Pass an
 *  empty `answerIds` to retract a vote (MSC3381 treats an empty answers array as "spoiled" —
 *  effectively "no vote counted" for this sender). */
export async function votePoll(mx: MatrixClient, roomId: string, pollEventId: string, answerIds: string[]): Promise<void> {
  const content = {
    'm.relates_to': { rel_type: REFERENCE_RELATION.name, event_id: pollEventId },
    [M_POLL_RESPONSE.name]: { answers: answerIds },
  };
  await mx.sendEvent(roomId, M_POLL_RESPONSE.name as any, content as any);
}

/** Closes a poll with an `m.poll.end` event. Per MSC3381 there's no dedicated "who can close a
 *  poll" permission — it piggybacks on redaction power, so `canEndPoll` below is just
 *  `canRedactEvent` against the poll's own start event (its creator, or anyone with the room's
 *  `redact` power level). */
export async function endPoll(mx: MatrixClient, roomId: string, pollEventId: string, closingMessage = 'The poll has ended.'): Promise<void> {
  const content = {
    'm.relates_to': { rel_type: REFERENCE_RELATION.name, event_id: pollEventId },
    [M_POLL_END.name]: {},
    [M_TEXT.name]: closingMessage,
  };
  await mx.sendEvent(roomId, M_POLL_END.name, content as any);
}

/** See `endPoll`'s doc comment — ending a poll takes the same authority as redacting its start
 *  event, so this is a thin, semantically-named wrapper over `canRedactEvent`. */
export function canEndPoll(room: Room, userId: string, pollStartEvent: MatrixEvent): boolean {
  return canRedactEvent(room, userId, pollStartEvent);
}

/** Pages of relations to read at most, so a poll with an enormous history can't stall the view. */
const MAX_RELATION_PAGES = 20;

/**
 * Every vote and end for a poll the server has, not just what's loaded in the timeline: the
 * `m.reference` relations of its start event (`/relations`, as Element does). Without this an old
 * poll showed only the votes this session had scrolled back far enough to load. Decrypted here,
 * since the SDK only decrypts relations when asked for one event type and votes come in two (the
 * stable and unstable names).
 */
export async function fetchPollRelations(mx: MatrixClient, roomId: string, pollEventId: string): Promise<MatrixEvent[]> {
  const events: MatrixEvent[] = [];
  let from: string | undefined;
  for (let page = 0; page < MAX_RELATION_PAGES; page++) {
    const result = await mx.relations(roomId, pollEventId, REFERENCE_RELATION.name, null, { dir: 'b' as any, from });
    await Promise.all(result.events.map((event) => mx.decryptEventIfNeeded(event)));
    events.push(...result.events.filter((event) => isPollResponseEvent(event) || isPollEndEvent(event)));
    if (!result.nextBatch) break;
    from = result.nextBatch;
  }
  return events;
}
