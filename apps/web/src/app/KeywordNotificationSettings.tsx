import { useEffect, useState, type FormEvent } from 'react';
import { useMatrixClient } from '../matrix/MatrixClientContext';
import { addKeyword, cleanKeyword, MAX_KEYWORDS, readKeywords, removeKeyword } from '../matrix/keywordNotifications';

/**
 * Words that notify you anywhere they're said (matrix/keywordNotifications.ts). Like the post
 * switches beside it, each change applies at once, not on the form's Save; the list is read from
 * the homeserver so it matches what Element shows too.
 */
export function KeywordNotificationSettings() {
  const mx = useMatrixClient();
  const [keywords, setKeywords] = useState<string[]>(() => readKeywords(mx.pushRules));
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    mx.getPushRules()
      .then((rules) => {
        if (!cancelled) setKeywords(readKeywords(rules));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mx]);

  const change = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      setKeywords(readKeywords(await mx.getPushRules()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t change your keywords');
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = (evt: FormEvent) => {
    evt.preventDefault();
    if (busy) return;
    const cleaned = cleanKeyword(draft, keywords);
    if ('error' in cleaned) {
      setError(cleaned.error);
      return;
    }
    void change(() => addKeyword(mx, cleaned.keyword)).then(() => setDraft(''));
  };

  return (
    <div className="nu-field" data-nu-role="keyword-notification-settings">
      Keywords
      <span className="nu-field__hint">
        Get notified when any of these is said in a channel you’re in, as if you’d been mentioned. A channel set to Nothing stays quiet.
      </span>
      {keywords.length > 0 && (
        <ul className="nu-keywords" data-nu-role="keyword-list">
          {keywords.map((keyword) => (
            <li key={keyword} className="nu-keywords__item" data-nu-role="keyword">
              <span>{keyword}</span>
              <button
                type="button"
                className="nu-keywords__remove"
                data-nu-role="keyword-remove"
                aria-label={`Remove ${keyword}`}
                disabled={busy}
                onClick={() => void change(() => removeKeyword(mx, keyword))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {keywords.length < MAX_KEYWORDS && (
        <form className="nu-keywords__add" onSubmit={handleAdd}>
          <input
            className="nu-field__input"
            data-nu-role="keyword-input"
            value={draft}
            placeholder="A word or phrase"
            maxLength={50}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="nu-button nu-button--secondary" data-nu-role="keyword-add" disabled={busy || !draft.trim()}>
            Add
          </button>
        </form>
      )}
      {error && <p className="nu-field__error">{error}</p>}
    </div>
  );
}
