import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import './TermsOfService.css';

/**
 * The terms are this server's, not the app's: /terms.html, which each install keeps in
 * custom/terms.html (deploy/docker-compose.yml mounts it, apps/web/deploy/40-purrlor-config.sh
 * puts it in place) and updates never replace. The image ships a sample (public/terms.html) for an
 * install that hasn't written its own yet.
 */
const TERMS_URL = '/terms.html';

/** The part of the terms page shown in the app: what's inside its <main>, without anything that
 *  could run or restyle the app. Null when the page has no <main>, which is also what the dev
 *  server's index.html fallback for a missing file looks like. */
export function termsContent(html: string): string | null {
  const main = new DOMParser().parseFromString(html, 'text/html').querySelector('main');
  if (!main) return null;
  main.querySelectorAll('script, style, link, iframe, object, embed, form').forEach((el) => el.remove());
  main.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on') || /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  });
  return main.innerHTML;
}

type TermsState = { status: 'loading' } | { status: 'ready'; html: string } | { status: 'missing' };

/** The terms themselves, as shown in the modal. */
export function TermsOfService() {
  const [state, setState] = useState<TermsState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch(TERMS_URL, { cache: 'no-cache' })
      .then((res) => (res.ok ? res.text() : null))
      .then((html) => {
        const content = html === null ? null : termsContent(html);
        if (!cancelled) setState(content === null ? { status: 'missing' } : { status: 'ready', html: content });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'missing' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return <p className="nu-terms nu-terms__date">Loading…</p>;
  }
  if (state.status === 'missing') {
    return (
      <p className="nu-terms" data-nu-role="terms-of-service">
        This server's terms couldn't be loaded. Try again later, or <a href={TERMS_URL}>open them on their own page</a>.
      </p>
    );
  }
  return <div className="nu-terms" data-nu-role="terms-of-service" dangerouslySetInnerHTML={{ __html: state.html }} />;
}

type TermsNoticeProps = {
  /** "By … you agree to our Terms of Service." */
  lead: string;
};

/** The small agreement note under the login/register forms, with a link that opens the terms. */
export function TermsNotice({ lead }: TermsNoticeProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className="nu-terms-notice" data-nu-role="terms-notice">
        {lead}{' '}
        <button type="button" className="nu-terms-notice__link" data-nu-role="terms-link" onClick={() => setOpen(true)}>
          Terms of Service
        </button>
        .
      </p>
      {open && (
        <Modal title="Terms of Service" onClose={() => setOpen(false)} wide>
          <TermsOfService />
        </Modal>
      )}
    </>
  );
}
