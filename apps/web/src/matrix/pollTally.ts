/**
 * Pure poll-tallying logic (MSC3381) — no matrix-js-sdk imports, so it's cheap to unit test with
 * plain objects. `matrix/polls.ts` turns raw MatrixEvents into the shapes this file works with;
 * `matrix/hooks/usePollTally.ts` wires it up live in a room.
 */

/** One of a poll's fixed answer choices, as declared by its `m.poll.start` event. */
export type PollAnswerDef = {
  id: string;
  text: string;
};

export type PollKind = 'disclosed' | 'undisclosed';

/** A poll's shape, independent of any votes cast against it. */
export type PollDefinition = {
  question: string;
  answers: PollAnswerDef[];
  kind: PollKind;
  /** Max answers a single response may select. Always >= 1; 1 means single-choice. */
  maxSelections: number;
};

/**
 * One user's raw `m.poll.response` event, reduced to what tallying needs. `ts` is the event's
 * `origin_server_ts` (or local-echo send time) — MSC3381 defines a user's counted vote as their
 * *latest* response sent *before* the poll closed, and this is what "latest"/"before" compare
 * against.
 */
export type PollResponseInput = {
  senderId: string;
  ts: number;
  /** Exactly as sent — may include ids the poll doesn't have, or more ids than maxSelections
   *  allows. tallyPoll sanitizes both before counting; nothing upstream needs to. */
  answerIds: string[];
};

export type PollTally = {
  ended: boolean;
  /** Vote count per answer id — every id from the poll's definition is present, 0 if unvoted. */
  counts: Record<string, number>;
  /** Distinct voters who contributed at least one counted vote (a response left with zero valid
   *  answers after sanitizing doesn't count as a voter). */
  totalVotes: number;
  /** The given user's own latest valid selection, regardless of poll kind or end state — a
   *  client always shows its own vote back to it, disclosed/undisclosed and open/ended alike. */
  myAnswerIds: string[];
};

/**
 * Tallies a poll's responses into vote counts.
 *
 * - Latest-vote-wins: only a sender's single latest (by `ts`, ties broken by the caller's array
 *   order — pass responses in timeline/stream order) response counts; any earlier one from the
 *   same sender is fully discarded, matching Matrix's revote convention (there's no per-response
 *   redaction for votes, a revote is just a new response event).
 * - Votes after `endTs` are dropped entirely before the latest-per-sender pass, so a message that
 *   arrives after the close can't un-close a poll's outcome even if it happens to be newer than
 *   the sender's actual final vote.
 * - `max_selections`: a response naming more answers than the poll allows keeps only the first
 *   `maxSelections` of them, in the order the sender listed them.
 * - Invalid answer ids (not one of the poll's own) are dropped from a response rather than
 *   discarding the whole response — a lenient reading of MSC3381 chosen so one bad id (e.g. from
 *   a buggy client) doesn't silently erase an otherwise-valid vote.
 */
export function tallyPoll(params: {
  definition: PollDefinition;
  responses: PollResponseInput[];
  /** The poll-closing event's timestamp, or null/undefined while still open. */
  endTs?: number | null;
  myUserId?: string | null;
}): PollTally {
  const { definition, responses, endTs, myUserId } = params;
  const validAnswerIds = new Set(definition.answers.map((a) => a.id));
  const maxSelections = Math.max(1, definition.maxSelections);

  // Stable sort (guaranteed by the spec since ES2019) keeps equal timestamps in the caller's
  // original order, which is the tiebreak MSC3381 defers to.
  const sorted = [...responses].sort((a, b) => a.ts - b.ts);
  const eligible = endTs == null ? sorted : sorted.filter((r) => r.ts <= endTs);

  const latestBySender = new Map<string, PollResponseInput>();
  for (const response of eligible) latestBySender.set(response.senderId, response);

  const sanitize = (answerIds: string[]): string[] =>
    [...new Set(answerIds)].filter((id) => validAnswerIds.has(id)).slice(0, maxSelections);

  const counts: Record<string, number> = {};
  for (const answer of definition.answers) counts[answer.id] = 0;

  let totalVotes = 0;
  for (const response of latestBySender.values()) {
    const validIds = sanitize(response.answerIds);
    if (validIds.length === 0) continue;
    totalVotes += 1;
    for (const id of validIds) counts[id] += 1;
  }

  const myLatest = myUserId ? latestBySender.get(myUserId) : undefined;
  const myAnswerIds = myLatest ? sanitize(myLatest.answerIds) : [];

  return { ended: endTs != null, counts, totalVotes, myAnswerIds };
}
