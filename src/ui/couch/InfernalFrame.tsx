import { memo } from 'react'

/*
 * The iron frame around Couch mode's blood orb: bone horns, a spiked crown, a ring of glowing runes
 * all the way round, inverted pentagram seals on either side, a blood gem at the bottom, and the
 * glass over the liquid. Drawn once; only the aura behind it pulses (in CSS) when divisions are back.
 * The orb's liquid sits in the hole at (150, 160) with radius 80 of this 300 × 300 box.
 */

const f1 = (v: number) => v.toFixed(1)
const polar = (r: number, deg: number, cx = 150, cy = 160): [number, number] => [
  cx + r * Math.cos((deg * Math.PI) / 180),
  cy + r * Math.sin((deg * Math.PI) / 180)
]
const star = (cx: number, cy: number, r: number, inverted: boolean) =>
  'M' +
  [0, 2, 4, 1, 3]
    .map((i) =>
      polar(r, (inverted ? 90 : -90) + i * 72, cx, cy)
        .map(f1)
        .join(' ')
    )
    .join('L') +
  'Z'

/** Elder-futhark-like runes as strokes in a 10 × 14 box around (0, 0), so they look the same on every phone. */
const RUNES = [
  'M-3 7V-7M-3-3L3-7M-3 1L3-3',
  'M-3 7V-7L3-3V7',
  'M-3 7V-7M-3-4L2 0L-3 4',
  'M-3 7V-7M-3-7L3-3M-3-3L3 1',
  'M-3 7V-7L2-4L-3-1L3 7',
  'M3-7L-3 0L3 7',
  'M-4-7L4 7M4-7L-4 7',
  'M-3-7V7M3-7V7M-3-2L3 2',
  'M0-7V7M-3-3L3 3',
  'M-1-7L-4-3L-1 1M1-1L4 3L1 7',
  'M0-7V7M0-7L3-4M0 7L-3 4',
  'M0 7V-7M-4-5L0-1L4-5',
  'M3-7L-3-2L3 2L-3 7',
  'M0 7V-7M-4-3L0-7L4-3',
  'M-3-7V7M-3-7L3-3.5L-3 0L3 3.5L-3 7',
  'M-3 7V-7L0-3L3-7V7',
  'M-3 7V-7L3 0M3 7V-7L-3 0',
  'M-2 7V-7L3-3',
  'M-4 7L3-1L0-5L-3-1L4 7',
  'M-4-6V6L4-6V6L-4-6'
]
const RUNE_COUNT = 40

const SPIKES = ['M150 26 L159 58 L141 58 Z', 'M116 36 L130 62 L113 67 Z', 'M184 36 L187 67 L170 62 Z', 'M90 54 L108 74 L93 83 Z', 'M210 54 L207 83 L192 74 Z']

function Frame() {
  return (
    <svg className="couch__frame" viewBox="0 0 300 300" aria-hidden="true">
      <defs>
        <linearGradient id="cz-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8a7358" />
          <stop offset=".25" stopColor="#3e3026" />
          <stop offset=".55" stopColor="#1c1510" />
          <stop offset=".8" stopColor="#4a3a2c" />
          <stop offset="1" stopColor="#15100c" />
        </linearGradient>
        <linearGradient id="cz-bone" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#1e1611" />
          <stop offset=".45" stopColor="#5e4a38" />
          <stop offset=".8" stopColor="#a88e6c" />
          <stop offset="1" stopColor="#e0ccaa" />
        </linearGradient>
        <radialGradient id="cz-aura" cx="50%" cy="50%" r="50%">
          <stop offset=".55" stopColor="#ff3a14" stopOpacity="0" />
          <stop offset=".72" stopColor="#ff3a14" stopOpacity=".38" />
          <stop offset="1" stopColor="#ff3a14" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="cz-glass" cx="32%" cy="24%" r="60%">
          <stop offset="0" stopColor="#fff" stopOpacity=".5" />
          <stop offset=".25" stopColor="#fff" stopOpacity=".1" />
          <stop offset=".6" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <filter id="cz-shade">
          <feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#000" floodOpacity=".9" />
        </filter>
        <filter id="cz-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <circle className="couch__aura" cx="150" cy="160" r="142" fill="url(#cz-aura)" />

      <g filter="url(#cz-shade)">
        <path d="M86 108 C 44 96, 12 58, 26 4 C 36 50, 58 72, 100 86 Z" fill="url(#cz-bone)" stroke="#0c0806" strokeWidth="1.5" />
        <path d="M214 108 C 256 96, 288 58, 274 4 C 264 50, 242 72, 200 86 Z" fill="url(#cz-bone)" stroke="#0c0806" strokeWidth="1.5" />
        {[0.25, 0.42, 0.58, 0.74].map((p) => (
          <g key={p} stroke="rgba(0,0,0,.5)" strokeWidth="1.4">
            <path d={`M${f1(30 + p * 50)} ${f1(30 + p * 52)} l${f1(8 - p * 4)} -${f1(6 - p * 3)}`} />
            <path d={`M${f1(270 - p * 50)} ${f1(30 + p * 52)} l-${f1(8 - p * 4)} -${f1(6 - p * 3)}`} />
          </g>
        ))}
        <g fill="url(#cz-ring)" stroke="#0c0806">
          {SPIKES.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
        <circle cx="150" cy="160" r="112" fill="none" stroke="#000" strokeWidth="22" />
        <circle cx="150" cy="160" r="112" fill="none" stroke="url(#cz-ring)" strokeWidth="18" />
        <circle cx="150" cy="160" r="121" fill="none" stroke="#6b5236" strokeWidth="1" opacity=".8" />
        <circle cx="150" cy="160" r="103" fill="none" stroke="#a8865a" strokeWidth="1" opacity=".7" />
      </g>

      {/* The runes, upright to the ring, glowing like embers in the iron. */}
      <g className="couch__runes" filter="url(#cz-glow)" fill="none" stroke="#ff5a32" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round">
        {Array.from({ length: RUNE_COUNT }, (_, i) => {
          const a = (i * 360) / RUNE_COUNT - 90
          const [x, y] = polar(112, a)
          return (
            <path
              key={i}
              d={RUNES[(i * 7) % RUNES.length]}
              transform={`translate(${f1(x)} ${f1(y)}) rotate(${f1(a + 90)}) scale(.58)`}
            />
          )
        })}
      </g>

      <g filter="url(#cz-shade)">
        {[22, 278].map((x) => (
          <g key={x} filter="url(#cz-glow)">
            <circle cx={x} cy="160" r="10.5" fill="#120806" stroke="#000" strokeWidth="1.5" />
            <circle cx={x} cy="160" r="8.6" fill="none" stroke="#c22a18" strokeWidth=".9" />
            <path d={star(x, 160, 7.6, true)} fill="none" stroke="#ff5a3a" strokeWidth="1" />
          </g>
        ))}
        <path d="M132 270 L150 252 L168 270 L150 292 Z" fill="url(#cz-ring)" stroke="#000" />
        <path d="M140 271 L150 260 L160 271 L150 284 Z" fill="#b0140a" stroke="#2a0202" />
        <path d={star(150, 272, 6.5, true)} fill="none" stroke="#ffb090" strokeWidth=".7" />
      </g>

      <circle cx="150" cy="160" r="81" fill="none" stroke="#000" strokeWidth="4" />
      <circle cx="150" cy="160" r="83.5" fill="none" stroke="#6b5236" strokeWidth="1.5" opacity=".6" />
      <circle cx="150" cy="160" r="80" fill="url(#cz-glass)" />
      <path d="M98 128 A 60 60 0 0 1 150 96" stroke="rgba(255,255,255,.5)" strokeWidth="3" strokeLinecap="round" fill="none" />
      <circle cx="112" cy="116" r="3" fill="rgba(255,255,255,.7)" />
    </svg>
  )
}

export const InfernalFrame = memo(Frame)
