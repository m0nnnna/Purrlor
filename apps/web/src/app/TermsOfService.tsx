import { useState } from 'react';
import { Modal } from '../components/Modal';
import './TermsOfService.css';

export const TERMS_EFFECTIVE_DATE = 'October 1, 2026';

/** Where copyright complaints and takedown requests go. One place to change it. */
export const TAKEDOWN_EMAIL = 'abuse@nekoops.net';

/** The terms themselves, as shown in the modal. */
export function TermsOfService() {
  return (
    <div className="nu-terms" data-nu-role="terms-of-service">
      <p className="nu-terms__date">Effective {TERMS_EFFECTIVE_DATE}</p>
      <p>
        By creating an account or using Purrlor you agree to these terms. If you don't agree, don't
        create an account.
      </p>

      <h3>1. Adults only (18+)</h3>
      <p>
        Purrlor is for adults. You must be at least 18 years old to create an account or use it. By
        accepting these terms you confirm that you are 18 or older. Accounts we find belonging to
        anyone under 18 are removed.
      </p>

      <h3>2. Your data</h3>
      <h4>End-to-end encrypted</h4>
      <ul>
        <li>
          Messages and files in direct messages, and in channels with end-to-end encryption turned
          on (new private channels have it by default), are encrypted on your device before they are
          sent. The server stores only the encrypted copy and can't read it.
        </li>
        <li>
          Media in private Spaces' posts and in "Only me" posts is encrypted in your browser before
          upload.
        </li>
        <li>
          Your encryption keys live on your devices and in a key backup protected by your recovery
          key. We never have your recovery key, so if you lose it and every signed-in device, we
          can't recover your encrypted history.
        </li>
      </ul>
      <h4>Not end-to-end encrypted</h4>
      <ul>
        <li>
          Public channels, channels with encryption turned off, and public posts and their comments.
        </li>
        <li>
          Your profile (display name, avatar, bio, banner, status) and the names and topics of
          Spaces and channels.
        </li>
        <li>
          Settings and things saved to your account, such as saved messages, reminders and the text
          of "Only me" posts.
        </li>
        <li>
          Account details and metadata: your username, email address if you give one, who is in
          which Space or channel, when messages are sent, and your sessions' device names and IP
          addresses.
        </li>
        <li>
          Voice and video calls are encrypted in transit through our voice server but are not
          end-to-end encrypted. Calls are not recorded.
        </li>
      </ul>
      <p>
        Everything is sent over encrypted connections (HTTPS), whether or not it is end-to-end
        encrypted. Unencrypted content can be read by the server's administrators; they only look at
        it to run the service, handle reports, or when the law requires it.
      </p>
      <h4>How it's kept</h4>
      <ul>
        <li>
          Your data is stored on our server until you or a moderator deletes it. Deleting a message
          removes its content from the server, but anyone who already saw it may have kept a copy.
        </li>
        <li>
          If a conversation includes people on other Matrix servers, those servers keep their own
          copies, which we can't delete.
        </li>
        <li>
          Background notifications go through your browser's push service (Google, Mozilla or
          Apple). Notifications for encrypted conversations don't include the message text.
        </li>
        <li>
          When you report a message, its content (decrypted, if it was encrypted) is sent to the
          moderators who review the report.
        </li>
        <li>
          We may disclose data we can read to law enforcement when legally required to.
        </li>
      </ul>

      <h3>3. Rules</h3>
      <ul>
        <li>
          <strong>Nothing illegal under United States law.</strong> This includes, but isn't limited
          to: any sexual content involving minors (reported to the NCMEC and law enforcement),
          sharing intimate images of someone without their consent, threats of violence, fraud,
          selling illegal goods or services, and copyright infringement.
        </li>
        <li>
          <strong>18+ content is allowed, but it must be marked with a content warning.</strong> In
          posts, use the CW button, and tick Sensitive for media. In chat, put a warning before it
          and hide it in <code>||spoilers||</code>.
        </li>
        <li>
          <strong>Unmarked 18+ content will result in a ban.</strong>
        </li>
      </ul>

      <h3>4. Copyright and takedowns</h3>
      <p>
        Only upload music, art and other files you made or have the right to share. Music and albums
        on a profile page are public to anyone on the web when its owner has chosen to show their
        page to people who aren't signed in. If you believe something here infringes your copyright,
        email <a href={`mailto:${TAKEDOWN_EMAIL}`}>{TAKEDOWN_EMAIL}</a> with what it is, where it is
        (a link to the page), and that you're the owner or act for them. We remove infringing content
        and may suspend accounts that repeatedly upload it.
      </p>

      <h3>5. Enforcement and changes</h3>
      <p>
        Moderators and administrators may remove content and suspend or ban accounts that break these
        terms. We may update these terms; continuing to use Purrlor after a change means you accept
        the updated terms.
      </p>
    </div>
  );
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
