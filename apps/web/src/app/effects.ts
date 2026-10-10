import { useSyncExternalStore } from 'react';

/**
 * How much of the Ultimit frame's drawing this device does (styles/base/frame.css):
 *
 * - **full** ("GPU"): the glass panels with their blur, the shard wallpaper, the window and ticker
 *   animations. Looks best; wants a graphics card.
 * - **safe**: flat, opaque panels, no wallpaper, no blur and no animation. The same layout and
 *   colors, drawn cheaply enough for an old laptop, a thin client or a browser without hardware
 *   acceleration.
 * - **auto** (the default): `safe` where the browser is drawing in software or the person asked
 *   their system for less motion, otherwise `full`.
 *
 * Kept per device in localStorage, like the custom theme: the same account can sign in on a gaming
 * PC and on a weak laptop. Applied as `data-nu-effects` on <html>, before the first render.
 */
export type EffectsSetting = 'auto' | 'full' | 'safe';
export type Effects = 'full' | 'safe';

const STORAGE_KEY = 'nekous_effects';
const TICKER_KEY = 'nekous_ticker';

export function readEffectsSetting(): EffectsSetting {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'full' || value === 'safe' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

/** Whether the browser draws in software: WebGL's renderer names a software rasterizer, or there's no WebGL at all. */
export function softwareRendering(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return true;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(renderer);
  } catch {
    return false;
  }
}

let autoResult: Effects | null = null;

/** What `auto` comes to on this device: worked out once per page load. */
function resolveAuto(): Effects {
  if (autoResult) return autoResult;
  const lessMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  autoResult = lessMotion || softwareRendering() ? 'safe' : 'full';
  return autoResult;
}

export function resolveEffects(setting: EffectsSetting): Effects {
  return setting === 'auto' ? resolveAuto() : setting;
}

const listeners = new Set<() => void>();

function apply(setting: EffectsSetting): void {
  document.documentElement.dataset.nuEffects = resolveEffects(setting);
  listeners.forEach((listener) => listener());
}

/** Call once at boot (main.tsx), before React renders, so a weak machine never draws the full frame first. */
export function applyEffectsOnLoad(): void {
  apply(readEffectsSetting());
}

export function saveEffectsSetting(setting: EffectsSetting): void {
  try {
    if (setting === 'auto') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, setting);
  } catch {
    // Applied for this visit even when it can't be kept.
  }
  apply(setting);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The effects in force right now, for components that skip work in safe mode (the wallpaper). */
export function useEffects(): Effects {
  return useSyncExternalStore(subscribe, () => (document.documentElement.dataset.nuEffects === 'safe' ? 'safe' : 'full'));
}

/** Whether the notification ticker runs along the bottom of the app. On unless turned off. */
export function readTickerOn(): boolean {
  try {
    return localStorage.getItem(TICKER_KEY) !== 'off';
  } catch {
    return true;
  }
}

let tickerOn = readTickerOn();

export function saveTickerOn(on: boolean): void {
  tickerOn = on;
  try {
    if (on) localStorage.removeItem(TICKER_KEY);
    else localStorage.setItem(TICKER_KEY, 'off');
  } catch {
    // As above.
  }
  listeners.forEach((listener) => listener());
}

export function useTickerOn(): boolean {
  return useSyncExternalStore(subscribe, () => tickerOn);
}
