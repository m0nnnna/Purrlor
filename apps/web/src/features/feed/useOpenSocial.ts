import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { globalFeedOpenAtom, openPostAtom, profileUserIdAtom, socialSpaceIdAtom, socialViewAtom, type SocialView } from '../../app/state/selection';

/**
 * Goes to one page of the social side (the Everyone or Following timeline, or Notifications),
 * closing a profile or post page sitting over it — from the rail, the social sidebar, or a tab.
 */
export function useOpenSocial(): (view: SocialView) => void {
  const setGlobalFeedOpen = useSetAtom(globalFeedOpenAtom);
  const setView = useSetAtom(socialViewAtom);
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  const setOpenPost = useSetAtom(openPostAtom);
  const setSocialSpaceId = useSetAtom(socialSpaceIdAtom);
  return useCallback(
    (view: SocialView) => {
      setOpenPost(null);
      setProfileUserId(null);
      setSocialSpaceId(null);
      setView(view);
      setGlobalFeedOpen(true);
    },
    [setGlobalFeedOpen, setView, setProfileUserId, setOpenPost, setSocialSpaceId]
  );
}

/** Opens a Space's Posts page inside the social side: the sidebar stays, and Back returns to the page before. */
export function useOpenSocialSpace(): (spaceId: string) => void {
  const setGlobalFeedOpen = useSetAtom(globalFeedOpenAtom);
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  const setOpenPost = useSetAtom(openPostAtom);
  const setSocialSpaceId = useSetAtom(socialSpaceIdAtom);
  return useCallback(
    (spaceId: string) => {
      setOpenPost(null);
      setProfileUserId(null);
      setSocialSpaceId(spaceId);
      setGlobalFeedOpen(true);
    },
    [setGlobalFeedOpen, setProfileUserId, setOpenPost, setSocialSpaceId]
  );
}
