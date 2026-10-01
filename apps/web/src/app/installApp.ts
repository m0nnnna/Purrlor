import { useSyncExternalStore } from 'react';

/**
 * Installing Purrlor as an app (public/manifest.webmanifest). Chrome, Edge and Android hand the
 * page a `beforeinstallprompt` event it can keep and fire later from its own button; iOS has no
 * such event, only Share → Add to Home Screen; Firefox on the desktop can't install at all. On an
 * iPhone it matters most: iOS delivers web push only to a site added to the home screen.
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installedNow = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** Called once from main.tsx, before the first render: the event fires early and only once. */
export function captureInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Keeps the browser's own mini-infobar away; Account Settings and the phone hint offer it.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installedNow = true;
    notify();
  });
}

export type InstallRoute = 'installed' | 'prompt' | 'ios' | 'browser-menu';

export type InstallEnvironment = {
  standalone: boolean;
  canPrompt: boolean;
  userAgent: string;
  maxTouchPoints: number;
};

/** iPhones, iPads, and iPads asking for the desktop site (which say "Macintosh" but have touch). */
export function isAppleMobile(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

export function installRoute(env: InstallEnvironment): InstallRoute {
  if (env.standalone) return 'installed';
  if (env.canPrompt) return 'prompt';
  if (isAppleMobile(env.userAgent, env.maxTouchPoints)) return 'ios';
  return 'browser-menu';
}

function isStandalone(): boolean {
  return (
    installedNow ||
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function currentRoute(): InstallRoute {
  return installRoute({
    standalone: isStandalone(),
    canPrompt: deferredPrompt !== null,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useInstallRoute(): InstallRoute {
  return useSyncExternalStore(subscribe, currentRoute);
}

/** Shows the browser's install dialog. Resolves true if the person installed. */
export async function promptInstall(): Promise<boolean> {
  const prompt = deferredPrompt;
  if (!prompt) return false;
  // A kept event can be used once; the browser fires a fresh one if it's dismissed.
  deferredPrompt = null;
  notify();
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome === 'accepted';
}

const HINT_DISMISSED_KEY = 'nekous_install_hint_dismissed';

export function installHintDismissed(): boolean {
  try {
    return localStorage.getItem(HINT_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissInstallHint(): void {
  try {
    localStorage.setItem(HINT_DISMISSED_KEY, '1');
  } catch {
    // Private mode: the hint comes back next time, which is fine.
  }
}
