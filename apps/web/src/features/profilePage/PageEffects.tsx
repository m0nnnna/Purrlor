import { useState } from 'react';
import type { PageEffect } from '../../matrix/profilePage';

const PARTICLES: Record<Exclude<PageEffect, 'none'>, string> = {
  sparkles: '✦',
  snow: '❄',
  hearts: '♥',
  stars: '★',
};

const COUNT = 18;
const EFFECTS_OFF_KEY = 'nekous_page_effects_off';

function effectsOff(): boolean {
  try {
    return localStorage.getItem(EFFECTS_OFF_KEY) === '1';
  } catch {
    return false;
  }
}

function setEffectsOff(off: boolean): void {
  try {
    if (off) localStorage.setItem(EFFECTS_OFF_KEY, '1');
    else localStorage.removeItem(EFFECTS_OFF_KEY);
  } catch {
    // Private mode: it lasts until the page is closed, which is fine.
  }
}

/**
 * A page's falling-particle effect, drawn behind its blocks. Built in, not something a page
 * describes: the page only names which one. For anyone whose device asks for reduced motion the
 * particles stand still where they are (ProfilePage.css): they used to be hidden altogether, so a
 * page's owner with animations off in Windows never saw the effect their visitors did. The visitor
 * can turn effects off on every page with one button; that's remembered for the visitor, not the page.
 */
export function PageEffects({ effect }: { effect: PageEffect }) {
  const [off, setOff] = useState(effectsOff);
  if (effect === 'none') return null;
  const particle = PARTICLES[effect];

  return (
    <>
      {!off && (
        <div className="nu-profile-page__effects" aria-hidden="true" data-nu-role="profile-page-effects">
          <div className="nu-profile-page__effects-view">
            {Array.from({ length: COUNT }, (_, i) => (
              <span
                key={i}
                className="nu-profile-page__particle"
                style={{
                  left: `${(i * 37) % 100}%`,
                  animationDelay: `${(i * 1.7) % 9}s`,
                  animationDuration: `${8 + ((i * 3) % 7)}s`,
                  fontSize: `${10 + ((i * 5) % 12)}px`,
                  // Where it rests when nothing may move.
                  ['--nu-particle-rest' as string]: `${4 + ((i * 53) % 90)}%`,
                }}
              >
                {particle}
              </span>
            ))}
          </div>
        </div>
      )}
      <button
        type="button"
        className="nu-profile-page__effects-toggle"
        data-nu-role="profile-page-effects-toggle"
        onClick={() => {
          setEffectsOff(!off);
          setOff(!off);
        }}
      >
        {off ? 'Show effects' : 'Hide effects'}
      </button>
    </>
  );
}
