import { createContext } from 'react';

/**
 * Whose page this is, for the blocks that depend on it (the Top 8 and the guestbook): their user
 * ID, their profile room when it's known, and whether the viewer is them. Provided by whatever
 * draws a page: the profile, the builder's preview, the signed-out view.
 */
export type PageOwner = { userId: string; roomId?: string; isMe: boolean };

export const PageOwnerContext = createContext<PageOwner | undefined>(undefined);
