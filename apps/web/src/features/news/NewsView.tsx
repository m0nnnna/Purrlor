import { useEffect, useState } from 'react';
import { useSetAtom } from 'jotai';
import type { Room } from 'matrix-js-sdk';
import { selectedRoomIdAtom, selectedSpaceViewAtom } from '../../app/state/selection';
import { Icon } from '../../components/Icon';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { useChannelCategories } from '../../matrix/hooks/useChannelCategories';
import { useRoomEmotes } from '../../matrix/hooks/useRoomEmotes';
import { useRoomMembers } from '../../matrix/hooks/useRoomMembers';
import { useSpaceNews } from '../../matrix/hooks/useSpaceNews';
import { useSpaceRooms } from '../../matrix/hooks/useSpaceRooms';
import { firstTextChannel, markNewsSeen, MAX_NEWS_LENGTH, saveSpaceNews } from '../../matrix/spaceNews';
import { renderMessageText } from '../messaging/renderMessageText';
import './NewsView.css';

const updatedFormat: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' };

/**
 * A Space's news page (matrix/spaceNews.ts): what opening the Space shows while there's news you
 * haven't seen. Opening it counts as seeing it. Anyone whose role may edit the news (Space Settings
 * → Roles) writes it here, and chooses whether a change is shown to everyone again.
 */
export function NewsView({ space }: { space: Room }) {
  const mx = useMatrixClient();
  const setSpaceView = useSetAtom(selectedSpaceViewAtom);
  const setSelectedRoomId = useSetAtom(selectedRoomIdAtom);
  const { news, canEdit } = useSpaceNews(space);
  const members = useRoomMembers(space.roomId);
  const emotes = useRoomEmotes(space);
  const firstChannel = firstTextChannel(useSpaceRooms(space.roomId), useChannelCategories(space));
  const [editing, setEditing] = useState(false);

  // Seen once it's on screen; again if it changes while you're looking at it.
  useEffect(() => {
    if (news) markNewsSeen(mx, space).catch((err: unknown) => console.warn('Couldn’t record the news as seen', err));
  }, [mx, space, news?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const author = news?.updatedBy ? (members.find((m) => m.userId === news.updatedBy)?.name ?? news.updatedBy) : undefined;

  return (
    <main className="nu-main-pane" data-nu-role="main-pane">
      <div className="nu-main-pane__header" data-nu-role="main-pane-header">
        <button
          type="button"
          className="nu-main-pane__header-back"
          data-nu-role="main-pane-back"
          title="Back to channels"
          aria-label="Back to channels"
          onClick={() => setSpaceView(null)}
        >
          <Icon name="arrowLeft" size={18} />
        </button>
        <Icon name="megaphone" size={20} className="nu-main-pane__header-icon" />
        <h1 className="nu-main-pane__header-name">News</h1>
        <div className="nu-main-pane__header-actions">
          {canEdit && !editing && (
            <button type="button" className="nu-button nu-button--secondary" data-nu-role="news-edit" onClick={() => setEditing(true)}>
              {news ? 'Edit' : 'Write news'}
            </button>
          )}
        </div>
      </div>
      <div className="nu-news" data-nu-role="news">
        {editing ? (
          <NewsEditor space={space} initial={news?.body ?? ''} hasNews={!!news} onDone={() => setEditing(false)} />
        ) : news ? (
          <article className="nu-news__article">
            <div className="nu-news__body" data-nu-role="news-body">
              {renderMessageText(news.body, emotes, members, mx.getUserId() ?? undefined)}
            </div>
            {news.updatedTs > 0 && (
              <p className="nu-news__meta" data-nu-role="news-meta">
                Updated {new Date(news.updatedTs).toLocaleString([], updatedFormat)}
                {author ? ` by ${author}` : ''}
              </p>
            )}
            {firstChannel && (
              <button
                type="button"
                className="nu-button nu-button--primary nu-news__continue"
                data-nu-role="news-continue"
                onClick={() => {
                  setSpaceView(null);
                  setSelectedRoomId(firstChannel.roomId);
                }}
              >
                Continue to #{firstChannel.name}
              </button>
            )}
          </article>
        ) : (
          <p className="nu-news__empty" data-nu-role="news-empty">
            {canEdit
              ? `No news yet. What you write here is the first thing everyone sees the next time they open ${space.name}.`
              : `${space.name} has no news right now.`}
          </p>
        )}
      </div>
    </main>
  );
}

function NewsEditor({ space, initial, hasNews, onDone }: { space: Room; initial: string; hasNews: boolean; onDone: () => void }) {
  const mx = useMatrixClient();
  const [body, setBody] = useState(initial);
  const [announce, setAnnounce] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const unchanged = body.trim() === initial.trim();

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await saveSpaceNews(mx, space, body, { announce });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the news');
      setSaving(false);
    }
  };

  return (
    <div className="nu-news__editor">
      <textarea
        className="nu-field__textarea nu-news__textarea"
        data-nu-role="news-input"
        value={body}
        maxLength={MAX_NEWS_LENGTH}
        placeholder={`What should everyone in ${space.name} know? Markdown works: **bold**, *italics*, links.`}
        autoFocus
        onChange={(e) => setBody(e.target.value)}
      />
      {hasNews && body.trim() && (
        <label className="nu-news__announce">
          <input type="checkbox" data-nu-role="news-announce" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} />
          Show it to everyone again on their next visit
          <span className="nu-field__hint">Leave this off for a small fix, like a typo, so people aren’t shown the news twice.</span>
        </label>
      )}
      {hasNews && !body.trim() && <p className="nu-field__hint">Saving it empty removes the news.</p>}
      {error && (
        <p className="nu-field__error" data-nu-role="news-error">
          {error}
        </p>
      )}
      <div className="nu-form-actions">
        <button type="button" className="nu-button nu-button--secondary" onClick={onDone} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className="nu-button nu-button--primary"
          data-nu-role="news-save"
          disabled={saving || unchanged || (!hasNews && !body.trim())}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : hasNews && !body.trim() ? 'Remove news' : 'Save'}
        </button>
      </div>
    </div>
  );
}
