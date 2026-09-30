import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { globalFeedOpenAtom, openPostAtom, profileUserIdAtom, socialViewAtom, type SocialView } from '../../app/state/selection';

/**
 * Goes to one page of the social side (the Everyone or Following timeline, or Notifications),
 * closing a profile or post page sitting over it — from the rail, the social sidebar, or a tab.
 */
export function useOpenSocial(): (view: SocialView) => void {
  const setGlobalFeedOpen = useSetAtom(globalFeedOpenAtom);
  const setView = useSetAtom(socialViewAtom);
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  const setOpenPost = useSetAtom(openPostAtom);
  return useCallback(
    (view: SocialView) => {
      setOpenPost(null);
      setProfileUserId(null);
      setView(view);
      setGlobalFeedOpen(true);
    },
    [setGlobalFeedOpen, setView, setProfileUserId, setOpenPost]
  );
}
