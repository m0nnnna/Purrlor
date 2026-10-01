import type { ReactNode } from 'react';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import type { ProfilePage } from '../../matrix/profilePage';
import { PageEffects } from './PageEffects';
import { pageStyleVars, usePageFonts } from './pageStyle';
import './ProfilePage.css';

/**
 * The styled surface a profile page sits on: its colours, background, fonts and effect, around
 * whatever the profile puts inside (the header card, the blocks, the posts). Without a page it
 * adds nothing, and the profile looks the way it always has.
 */
export function ProfilePageFrame({ page, children }: { page?: ProfilePage; children: ReactNode }) {
  const background = page?.style.background;
  const backgroundSrc = useMediaUrl(background?.kind === 'image' ? background.url : null);
  usePageFonts(page?.style);
  if (!page) return <>{children}</>;

  return (
    <div
      className={page.style.columns === 2 ? 'nu-profile-page nu-profile-page--two-columns' : 'nu-profile-page'}
      style={pageStyleVars(page.style, backgroundSrc)}
      data-nu-role="profile-page"
    >
      <PageEffects effect={page.style.effect} />
      <div className="nu-profile-page__content">{children}</div>
    </div>
  );
}
