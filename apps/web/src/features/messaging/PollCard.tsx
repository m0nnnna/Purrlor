import { useState } from 'react';
import type { MatrixEvent, Room } from 'matrix-js-sdk';
import { Icon } from '../../components/Icon';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { usePollTally } from '../../matrix/hooks/usePollTally';
import { canEndPoll, endPoll, votePoll } from '../../matrix/polls';
import './PollCard.css';

/**
 * Renders an `m.poll.start` event in the timeline (see MessageTimeline.tsx's MessageRow, which
 * hands us the event and dispatches here instead of the usual text/media branches). All live
 * results come from usePollTally, which does its own aggregation of the poll's (hidden)
 * response/end events — this component only turns that into UI and sends votes/the close.
 */
export function PollCard({ room, event }: { room: Room; event: MatrixEvent }) {
  const mx = useMatrixClient();
  const state = usePollTally(room, event);
  const [voting, setVoting] = useState(false);
  const [ending, setEnding] = useState(false);
  // A multi-choice draft selection, kept locally until "Vote" is pressed — null means "no
  // unsaved change", i.e. show the server's own myAnswerIds.
  const [draft, setDraft] = useState<string[] | null>(null);
  const [error, setError] = useState<string>();

  // Malformed poll content (see parsePollStart) — nothing sane to render.
  if (!state) return null;
  const { definition, tally } = state;

  const pollEventId = event.getId();
  const myUserId = mx.getUserId();
  const isSingleChoice = definition.maxSelections <= 1;
  const hasVoted = tally.myAnswerIds.length > 0;
  const showResults = tally.ended || definition.kind === 'disclosed';
  const canEnd = !tally.ended && !!myUserId && canEndPoll(room, myUserId, event);
  const selection = draft ?? tally.myAnswerIds;

  const castVote = async (answerIds: string[]) => {
    if (!pollEventId || voting || tally.ended) return;
    setVoting(true);
    setError(undefined);
    try {
      await votePoll(mx, room.roomId, pollEventId, answerIds);
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to vote');
    } finally {
      setVoting(false);
    }
  };

  const pickSingle = (answerId: string) => {
    if (tally.ended || (selection.length === 1 && selection[0] === answerId)) return;
    void castVote([answerId]);
  };

  const toggleMulti = (answerId: string) => {
    if (tally.ended) return;
    setDraft((prev) => {
      const base = prev ?? tally.myAnswerIds;
      if (base.includes(answerId)) return base.filter((id) => id !== answerId);
      if (base.length >= definition.maxSelections) return base; // already at the limit
      return [...base, answerId];
    });
  };

  const handleEnd = async () => {
    if (!pollEventId || ending) return;
    setEnding(true);
    setError(undefined);
    try {
      await endPoll(mx, room.roomId, pollEventId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to end the poll');
    } finally {
      setEnding(false);
    }
  };

  return (
    <div className="nu-poll" data-nu-role="poll-card">
      <div className="nu-poll__header">
        <Icon name="poll" size={16} className="nu-poll__icon" />
        <span className="nu-poll__question">{definition.question}</span>
        {tally.ended && (
          <span className="nu-poll__ended-badge" data-nu-role="poll-ended-badge">
            Ended
          </span>
        )}
      </div>
      <div className="nu-poll__answers" role="group" aria-label={definition.question}>
        {definition.answers.map((answer) => {
          const count = tally.counts[answer.id] ?? 0;
          const pct = tally.totalVotes > 0 ? Math.round((count / tally.totalVotes) * 100) : 0;
          const isMine = selection.includes(answer.id);
          return (
            <button
              key={answer.id}
              type="button"
              className={isMine ? 'nu-poll__answer nu-poll__answer--selected' : 'nu-poll__answer'}
              data-nu-role="poll-answer"
              disabled={tally.ended || voting}
              aria-pressed={isMine}
              onClick={() => (isSingleChoice ? pickSingle(answer.id) : toggleMulti(answer.id))}
            >
              {showResults && <span className="nu-poll__answer-bar" style={{ width: `${pct}%` }} aria-hidden="true" />}
              <span className="nu-poll__answer-marker" aria-hidden="true" />
              <span className="nu-poll__answer-text">{answer.text}</span>
              {showResults && (
                <span className="nu-poll__answer-count">
                  {count} · {pct}%
                </span>
              )}
            </button>
          );
        })}
      </div>
      {!isSingleChoice && !tally.ended && (
        <button
          type="button"
          className="nu-button nu-button--secondary nu-poll__submit"
          data-nu-role="poll-submit"
          disabled={voting || selection.length === 0 || draft === null}
          onClick={() => void castVote(selection)}
        >
          {hasVoted ? 'Change vote' : 'Vote'}
        </button>
      )}
      {error && <p className="nu-field__error">{error}</p>}
      <div className="nu-poll__footer">
        <span className="nu-poll__meta" data-nu-role="poll-meta">
          {tally.totalVotes} {tally.totalVotes === 1 ? 'vote' : 'votes'}
          {!tally.ended && definition.kind === 'undisclosed' && ' · Votes hidden until the poll ends'}
          {!tally.ended && !isSingleChoice && ` · Pick up to ${definition.maxSelections}`}
        </span>
        {canEnd && (
          <button type="button" className="nu-poll__end" data-nu-role="poll-end" disabled={ending} onClick={() => void handleEnd()}>
            {ending ? 'Ending…' : 'End poll'}
          </button>
        )}
      </div>
    </div>
  );
}
