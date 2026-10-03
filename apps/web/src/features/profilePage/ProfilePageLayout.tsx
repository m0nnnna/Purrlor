import type { ReactNode } from 'react';
import type { PageBlock, ProfilePage } from '../../matrix/profilePage';
import { FloatingSong } from './FloatingSong';
import { PageBlocks } from './PageBlocks';

/**
 * How a profile with a page is laid out: the header (banner, name, bio) across the top, then the
 * owner's modules in a column either side of the posts, each module where they put it
 * (PageBlock.side). Where there isn't room for three columns (a phone, a narrow window) it's one:
 * the left modules, then the right ones, then the posts, every module closed to its title so the
 * posts are a short scroll away. The profile song plays in a floating window, not a column.
 * Without a page there are no modules: the header, then the posts, as profiles always were.
 */
export function ProfilePageLayout({
  page,
  header,
  posts,
  openIds,
  showSong = true,
}: {
  page?: ProfilePage;
  header: ReactNode;
  posts: ReactNode;
  /** Modules to show open, as the builder's preview does for the block being edited. */
  openIds?: string[];
  /** False while the owner's builder is open over the profile: its preview has the song instead. */
  showSong?: boolean;
}) {
  const blocks = page?.blocks ?? [];
  const left = blocks.filter((block) => block.type !== 'song' && block.side !== 'right');
  const right = blocks.filter((block) => block.type !== 'song' && block.side === 'right');
  const song = blocks.find((block): block is Extract<PageBlock, { type: 'song' }> => block.type === 'song');
  const className = [
    'nu-profile-page__layout',
    left.length > 0 && 'nu-profile-page__layout--left',
    right.length > 0 && 'nu-profile-page__layout--right',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <div className={className} data-nu-role="profile-page-layout">
        <div className="nu-profile-page__header">{header}</div>
        {left.length > 0 && (
          <aside className="nu-profile-page__side nu-profile-page__side--left" data-nu-role="profile-page-left">
            <PageBlocks blocks={left} openIds={openIds} />
          </aside>
        )}
        {right.length > 0 && (
          <aside className="nu-profile-page__side nu-profile-page__side--right" data-nu-role="profile-page-right">
            <PageBlocks blocks={right} openIds={openIds} />
          </aside>
        )}
        <div className="nu-profile-page__main">{posts}</div>
      </div>
      {song && showSong && <FloatingSong block={song} accent={page?.style.colors.accent} />}
    </>
  );
}
