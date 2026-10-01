import { useState, type FormEvent } from 'react';
import type { MatrixEvent, Room } from 'matrix-js-sdk';
import { Modal } from '../../components/Modal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { feedJoinVia } from '../../matrix/feed';
import { reportContent } from '../../matrix/moderation';
import { readModerationConfig, reportToSpaceModerators } from '../../matrix/reports';
import { serverNameOf } from '../../matrix/roomOrigin';

/**
 * Reporting a message, post or comment. It always goes to the homeserver's admins; for a message
 * in a channel of a Space with report review, it also goes to that Space's moderators
 * (matrix/reports.ts), who are usually the ones who can do something about it.
 */
export function ReportDialog({
  roomId,
  eventId,
  what,
  ownerId,
  event,
  space,
  postId,
  onClose,
}: {
  roomId: string;
  eventId: string;
  /** A feed's owner, whose server is the way into the room when reporting needs joining it. */
  ownerId?: string;
  what: 'post' | 'comment' | 'message' | 'page';
  /** The reported event and its Space, for reaching the Space's moderators. */
  event?: MatrixEvent;
  space?: Room;
  /** For a post or comment: the post it is or sits under, so a moderator can open it from the queue. */
  postId?: string;
  onClose: () => void;
}) {
  const mx = useMatrixClient();
  const server = serverNameOf(mx.getUserId() ?? '') || 'your server';
  const toModerators = !!(event && space && readModerationConfig(space).reviewRoomId);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();

  const handleSubmit = async (evt: FormEvent) => {
    evt.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await reportContent(mx, roomId, eventId, reason.trim(), ownerId ? feedJoinVia(roomId, ownerId) : []);
      if (toModerators) {
        const about = (what === 'post' || what === 'comment') && postId ? { kind: what, postId } : undefined;
        await reportToSpaceModerators(mx, space!, event!, reason.trim(), about);
      }
      setSent(true);
    } catch (err) {
      // A Space's feed only lets its members in, and so only they can report there.
      const forbidden = (err as { httpStatus?: number } | null)?.httpStatus === 403;
      setError(
        forbidden
          ? `Only members of this space can report its ${what}s.`
          : err instanceof Error
            ? err.message
            : `Couldn’t report that ${what}`
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Report ${what}`} onClose={onClose}>
      {sent ? (
        <div className="nu-modal-form" data-nu-role="report-sent">
          <p>
            Thanks. {toModerators ? `The moderators of ${space!.name} and the admins of ${server}` : `The admins of ${server}`} have
            been sent this {what}.
          </p>
          <div className="nu-form-actions">
            <button type="button" className="nu-button nu-button--primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form className="nu-modal-form" onSubmit={handleSubmit} data-nu-role="report-dialog">
          <p>
            This sends the {what} to {toModerators ? `the moderators of ${space!.name} and ` : ''}the admins of {server}. Its author isn’t
            told who reported it.
          </p>
          <label className="nu-field">
            What’s wrong with it? (optional)
            <textarea
              className="nu-field__textarea"
              data-nu-role="report-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </label>
          {error && <p className="nu-field__error">{error}</p>}
          <div className="nu-form-actions">
            <button type="button" className="nu-button nu-button--secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="nu-button nu-button--primary" data-nu-role="report-submit" disabled={busy}>
              {busy ? 'Reporting…' : 'Report'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
