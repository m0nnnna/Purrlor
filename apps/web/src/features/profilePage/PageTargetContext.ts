import { atom } from 'jotai';
import { createContext } from 'react';
import type { PageTarget } from '../../matrix/publicWeb';

/**
 * What a link to a page pointed at (`/@name/music/<album>`, …): the album to open, the piece to
 * show. Provided by whatever draws a page; the blocks open it once, when they're first drawn.
 */
export const PageTargetContext = createContext<PageTarget | undefined>(undefined);

/** Signed in, a link to something on a page opens that profile (useOpenPublicRoute) with this. */
export const pageTargetAtom = atom<{ userId: string; target: PageTarget } | null>(null);
