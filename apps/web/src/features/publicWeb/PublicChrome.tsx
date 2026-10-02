import type { ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { MusicPlayerBar } from '../music/MusicPlayerBar';
import { MusicPlayerHost } from '../music/MusicPlayerHost';
import './PublicWeb.css';

/**
 * The frame around everything a signed-out visitor sees: the Purrlor name, the feed, and the two
 * ways in. The page content scrolls inside it.
 */
export function PublicChrome({
  children,
  onSignIn,
  onRegister,
}: {
  children: ReactNode;
  onSignIn: () => void;
  onRegister: () => void;
}) {
  return (
    <div className="nu-public" data-nu-role="public-web">
      <header className="nu-public__bar">
        <a className="nu-public__brand" href="/">
          <Icon name="paw" size={20} /> Purrlor
        </a>
        <nav className="nu-public__nav">
          <a href="/feed" className="nu-public__nav-link">
            Global feed
          </a>
          <button type="button" className="nu-public__nav-link" onClick={onSignIn} data-nu-role="public-sign-in">
            Sign in
          </button>
          <button type="button" className="nu-button nu-button--primary" onClick={onRegister} data-nu-role="public-join">
            Join Purrlor
          </button>
        </nav>
      </header>
      <div className="nu-public__scroll">{children}</div>
      {/* Page music, under whatever the visitor scrolls to. */}
      <MusicPlayerHost />
      <MusicPlayerBar variant="bar" />
    </div>
  );
}
