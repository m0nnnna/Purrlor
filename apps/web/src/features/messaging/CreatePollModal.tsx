import { useState, type FormEvent } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { createPoll } from '../../matrix/polls';
import type { PollKind } from '../../matrix/pollTally';
import './CreatePollModal.css';

const MIN_ANSWERS = 2;
const MAX_ANSWERS = 20;

/**
 * The composer's "Poll" attach option (Composer.tsx). Sends an MSC3381 `m.poll.start` event —
 * see matrix/polls.ts for the wire format. Kept as its own modal rather than inline in the
 * composer, matching how every other composer attachment that needs more than one field
 * (EmoteManagerModal, ForwardMessageModal) gets its own.
 */
export function CreatePollModal({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const mx = useMatrixClient();
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState<string[]>(['', '']);
  const [kind, setKind] = useState<PollKind>('disclosed');
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [maxSelections, setMaxSelections] = useState(2);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const updateAnswer = (index: number, value: string) => {
    setAnswers((prev) => prev.map((a, i) => (i === index ? value : a)));
  };

  const addAnswer = () => {
    if (answers.length >= MAX_ANSWERS) return;
    setAnswers((prev) => [...prev, '']);
  };

  const removeAnswer = (index: number) => {
    if (answers.length <= MIN_ANSWERS) return;
    setAnswers((prev) => prev.filter((_, i) => i !== index));
  };

  const filledAnswerCount = answers.filter((a) => a.trim()).length;

  const handleSubmit = async (evt: FormEvent) => {
    evt.preventDefault();
    const trimmedQuestion = question.trim();
    const trimmedAnswers = answers.map((a) => a.trim()).filter(Boolean);
    if (!trimmedQuestion) {
      setError('Add a question');
      return;
    }
    if (trimmedAnswers.length < MIN_ANSWERS) {
      setError(`Add at least ${MIN_ANSWERS} answers`);
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await createPoll(mx, roomId, {
        question: trimmedQuestion,
        answers: trimmedAnswers,
        kind,
        maxSelections: allowMultiple ? Math.min(Math.max(2, maxSelections), trimmedAnswers.length) : 1,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create the poll');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Create Poll" onClose={onClose}>
      <form className="nu-modal-form" onSubmit={handleSubmit}>
        <label className="nu-field">
          Question
          <input
            className="nu-field__input"
            data-nu-role="poll-create-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What should we get for the office cats?"
            autoFocus
            required
          />
        </label>
        <div className="nu-field">
          <span>Answers</span>
          <div className="nu-poll-create__answers" data-nu-role="poll-create-answers">
            {answers.map((answer, index) => (
              <div className="nu-poll-create__answer-row" key={index}>
                <input
                  className="nu-field__input"
                  data-nu-role="poll-create-answer"
                  value={answer}
                  onChange={(e) => updateAnswer(index, e.target.value)}
                  placeholder={`Answer ${index + 1}`}
                  required
                />
                <button
                  type="button"
                  className="nu-poll-create__answer-remove"
                  data-nu-role="poll-create-answer-remove"
                  title="Remove answer"
                  aria-label="Remove answer"
                  disabled={answers.length <= MIN_ANSWERS}
                  onClick={() => removeAnswer(index)}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="nu-button nu-button--secondary"
            data-nu-role="poll-create-add-answer"
            disabled={answers.length >= MAX_ANSWERS}
            onClick={addAnswer}
          >
            Add answer
          </button>
          <p className="nu-field__hint">{filledAnswerCount} of up to {MAX_ANSWERS} answers</p>
        </div>
        <div className="nu-field">
          <span>Results</span>
          <label className="nu-poll-create__radio-row">
            <input type="radio" name="poll-kind" checked={kind === 'disclosed'} onChange={() => setKind('disclosed')} />
            Show votes as they come in
          </label>
          <label className="nu-poll-create__radio-row">
            <input type="radio" name="poll-kind" checked={kind === 'undisclosed'} onChange={() => setKind('undisclosed')} />
            Hide votes until the poll ends
          </label>
        </div>
        <div className="nu-field__checkbox-row">
          <label>
            <input
              type="checkbox"
              checked={allowMultiple}
              onChange={(e) => setAllowMultiple(e.target.checked)}
            />{' '}
            Allow multiple answers
          </label>
          {allowMultiple && (
            <label className="nu-poll-create__max-selections">
              Up to
              <input
                className="nu-field__input"
                type="number"
                min={2}
                max={Math.max(2, answers.length)}
                value={maxSelections}
                onChange={(e) => setMaxSelections(Number(e.target.value) || 2)}
              />
              answers
            </label>
          )}
        </div>
        {error && <p className="nu-field__error">{error}</p>}
        <div className="nu-form-actions">
          <button type="submit" className="nu-button nu-button--primary" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create Poll'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
