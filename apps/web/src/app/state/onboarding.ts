import { atom } from 'jotai';

/** The welcome guide is showing (features/onboarding/WelcomeGuideHost.tsx): opened by itself for
 *  someone new, or from Account Settings. */
export const welcomeGuideOpenAtom = atom(false);
