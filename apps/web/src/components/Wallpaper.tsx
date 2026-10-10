import { useId } from 'react';
import './Wallpaper.css';

/**
 * The crystal-shard wallpaper behind the app shell and the sign-in screen: a fan of glass shards
 * from the lower left, a hex grid fading out toward the top right, and a ring gauge inside it. It's
 * the Ultimit desktop's (github.com/m0nnnna/ultimit, docs/design/mockup.html) drawn once as static
 * SVG: no canvas, no animation loop, nothing that costs a game or a call a frame.
 *
 * Every color comes from the `--nu-wall-*` tokens (styles/tokens.css), which default to mixes of
 * the theme's own colors, so a custom theme recolors it without knowing it exists. A theme hides it
 * with `--nu-wallpaper-opacity: 0`.
 */

const W = 1440;
const H = 900;
const RAIL = 84;

/** The mockup's seeded generator (mulberry32), so the shards land in the same places every time. */
function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r = (n: number) => Math.round(n);

interface Shard {
  body: string;
  shade: string;
  edge: string;
  alpha: number;
}

interface Geometry {
  pivot: { x: number; y: number; radius: number };
  shards: Shard[];
  /** Hex cells grouped by stroke strength, one path per group. */
  hexes: { d: string; alpha: number }[];
  /** The few cells drawn filled, grouped the same way. */
  hexFills: { d: string; alpha: number }[];
  ring: { x: number; y: number; scale: number; ticks: string; arcs: string };
}

function buildGeometry(): Geometry {
  const px = RAIL + (W - RAIL) * 0.3;
  const py = H * 0.7;
  const R = Math.min(W * 0.42, H * 0.62);
  const sc = Math.max(0.6, Math.min(W, H) / 800);

  const density = 34;
  const next = rng(7);
  const specs: { a: number; r0: number; L: number; t: number; al: number }[] = [];
  for (let i = 0; i < density; i++) {
    const k = i / (density - 1);
    specs.push({
      a: -2.95 + k * 2.7 + (next() - 0.5) * 0.08,
      r0: 0.06 + next() * 0.26,
      L: (0.45 + next() * 0.55) * (0.55 + 0.65 * k),
      t: 5 + next() * 17,
      al: 0.55 + next() * 0.45,
    });
  }
  for (let i = 0; i < Math.round(density / 5); i++) {
    specs.push({ a: 0.15 + next() * 0.7, r0: 0.1 + next() * 0.2, L: 0.2 + next() * 0.3, t: 4 + next() * 8, al: 0.25 + next() * 0.25 });
  }
  const shards = specs.map((s) => {
    const ux = Math.cos(s.a);
    const uy = Math.sin(s.a);
    const at = (u: number, v: number) => `${r(px + ux * u - uy * v)},${r(py + uy * u + ux * v)}`;
    const r0 = s.r0 * R;
    const L = s.L * R;
    const tw = s.t * sc;
    const A = at(r0, -tw);
    const B = at(r0 + L * 0.92, -tw * 0.25);
    const C = at(r0 + L, 0);
    const D = at(r0 + L * 0.3, tw);
    return { body: `${A} ${B} ${C} ${D}`, shade: `${A} ${C} ${D}`, edge: `${A} ${B} ${C}`, alpha: Math.round(s.al * 100) / 100 };
  });

  const hexRng = rng(11);
  const size = 24 * Math.max(0.7, Math.min(W, H) / 800);
  const hw = Math.sqrt(3) * size;
  const cx = W * 0.8;
  const cy = H * 0.2;
  const strokes = new Map<number, string>();
  const fills = new Map<number, string>();
  for (let row = 0; row * size * 1.5 < H * 0.7; row++) {
    for (let col = 0; col * hw < W * 0.55 + hw; col++) {
      const x = W * 0.45 + col * hw + (row % 2 ? hw / 2 : 0);
      const y = row * size * 1.5;
      const alpha = 0.24 - (Math.hypot(x - cx, y - cy) / (Math.min(W, H) * 0.5)) * 0.2;
      const filled = hexRng() < 0.1;
      if (alpha <= 0.02) continue;
      const bucket = Math.round(alpha * 40) / 40;
      let d = '';
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        d += `${i ? 'L' : 'M'}${r(x + (size - 2) * Math.cos(a))} ${r(y + (size - 2) * Math.sin(a))}`;
      }
      d += 'Z';
      strokes.set(bucket, (strokes.get(bucket) ?? '') + d);
      if (filled) fills.set(bucket, (fills.get(bucket) ?? '') + d);
    }
  }

  const rx = W * 0.8;
  const ry = H * 0.22;
  const arc = (a0: number, a1: number, rr: number) =>
    `M${r(rx + Math.cos(a0) * rr)} ${r(ry + Math.sin(a0) * rr)}A${r(rr)} ${r(rr)} 0 0 1 ${r(rx + Math.cos(a1) * rr)} ${r(ry + Math.sin(a1) * rr)}`;
  let ticks = '';
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const len = i % 6 ? 4 : 9;
    const r0 = 150 * sc;
    ticks += `M${r(rx + Math.cos(a) * r0)} ${r(ry + Math.sin(a) * r0)}L${r(rx + Math.cos(a) * (r0 + len))} ${r(ry + Math.sin(a) * (r0 + len))}`;
  }

  return {
    pivot: { x: r(px), y: r(py), radius: r(R) },
    shards,
    hexes: [...strokes].map(([alpha, d]) => ({ alpha, d })),
    hexFills: [...fills].map(([alpha, d]) => ({ alpha: Math.round(alpha * 60) / 100, d })),
    ring: { x: r(rx), y: r(ry), scale: sc, ticks, arcs: `${arc(0, 1.3, 120 * sc)} ${arc(3.2, 3.6, 120 * sc)}` },
  };
}

// Pure and deterministic, so worked out once for the whole app rather than on every render.
const GEOMETRY = buildGeometry();

export function Wallpaper() {
  const id = useId().replace(/:/g, '');
  const g = GEOMETRY;
  return (
    <div className="nu-wallpaper" data-nu-role="wallpaper" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" focusable="false">
        <defs>
          <linearGradient id={`${id}-ground`} x1="0" y1="1" x2="0.9" y2="0">
            <stop offset="0" className="nu-wallpaper__ground-start" />
            <stop offset="1" className="nu-wallpaper__ground-end" />
          </linearGradient>
          <radialGradient id={`${id}-vignette`} cx="0.5" cy="0.5" r="0.75">
            <stop offset="0.3" className="nu-wallpaper__vignette-clear" />
            <stop offset="1" className="nu-wallpaper__vignette-dark" />
          </radialGradient>
          <radialGradient id={`${id}-shard`} gradientUnits="userSpaceOnUse" cx={g.pivot.x} cy={g.pivot.y} r={g.pivot.radius}>
            <stop offset="0" className="nu-wallpaper__shard-stop" stopOpacity="0" />
            <stop offset="0.35" className="nu-wallpaper__shard-stop" stopOpacity="0.45" />
            <stop offset="1" className="nu-wallpaper__shard-stop" stopOpacity="0.95" />
          </radialGradient>
        </defs>
        <rect width={W} height={H} fill={`url(#${id}-ground)`} />
        <rect width={W} height={H} fill={`url(#${id}-vignette)`} />
        <g className="nu-wallpaper__hexes">
          {g.hexes.map((h) => (
            <path key={h.alpha} d={h.d} strokeOpacity={h.alpha} />
          ))}
          {g.hexFills.map((h) => (
            <path key={`f${h.alpha}`} d={h.d} className="nu-wallpaper__hex-fill" fillOpacity={h.alpha} />
          ))}
        </g>
        <g className="nu-wallpaper__ring">
          {[70, 98, 150].map((rr) => (
            <circle key={rr} cx={g.ring.x} cy={g.ring.y} r={Math.round(rr * g.ring.scale)} strokeOpacity={0.14} />
          ))}
          <path d={g.ring.arcs} strokeWidth={2} strokeOpacity={0.4} />
          <path d={g.ring.ticks} strokeOpacity={0.22} />
        </g>
        <g className="nu-wallpaper__shards" fill={`url(#${id}-shard)`}>
          {g.shards.map((s, i) => (
            <polygon key={i} points={s.body} fillOpacity={s.alpha} />
          ))}
        </g>
        <g className="nu-wallpaper__shades">
          {g.shards.map((s, i) => (
            <polygon key={i} points={s.shade} />
          ))}
        </g>
        <g className="nu-wallpaper__edges">
          {g.shards.map((s, i) => (
            <polyline key={i} points={s.edge} strokeOpacity={s.alpha} />
          ))}
        </g>
      </svg>
    </div>
  );
}
