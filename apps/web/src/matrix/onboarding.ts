import type { MatrixClient } from 'matrix-js-sdk';

/**
 * The welcome guide (features/onboarding/WelcomeGuide.tsx): shown once to someone new, then never
 * again on any of their devices, which is why "seen it" lives in their account data rather than
 * this browser. Someone already in a Space isn't new, whatever their account data says: an account
 * from before the guide existed doesn't get it either.
 */
export const ONBOARDING_EVENT = 'xyz.nekous.onboarding';

export function onboardingDone(mx: MatrixClient): boolean {
  return mx.getAccountData(ONBOARDING_EVENT as never)?.getContent<{ done?: unknown }>()?.done === true;
}

export function inAnySpace(mx: MatrixClient): boolean {
  return mx.getRooms().some((room) => room.isSpaceRoom() && room.getMyMembership() === 'join');
}

/** Whether to open the guide by itself: someone who hasn't seen it and isn't in any Space yet. */
export function shouldWelcome(mx: MatrixClient): boolean {
  return !onboardingDone(mx) && !inAnySpace(mx);
}

export async function markOnboardingDone(mx: MatrixClient): Promise<void> {
  if (onboardingDone(mx)) return;
  await mx.setAccountData(ONBOARDING_EVENT as never, { done: true, at: Date.now() } as never);
}
