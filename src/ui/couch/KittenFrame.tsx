import { memo } from 'react'

/*
 * The kitten's frame around Couch mode's orb: a rose-gold ring carved with tiny sigils (hearts, paw
 * prints, inverted pentagrams, moons, fish bones), a little horned demon kitten sitting on top with
 * its spade-tipped tail wrapped down the side, and a collar bell at the bottom. The kitten is the
 * status light; its moods are classes on the orb (in CSS): asleep while every division is out,
 * awake when one is back or the warband marches, wings out when the loop is ready.
 * Drawn in its own 300 × 330 space around a ring centred at (150, 190), then fitted so the hole
 * (radius 104 there) lands on the orb's hole at (150, 160), radius 80, of the 300 × 300 box.
 */

const f1 = (v: number) => v.toFixed(1)
const CX = 150
const CY = 190
const R_OUT = 124
const R_IN = 104
const R_SIG = 114
const pt = (deg: number, r: number): [number, number] => [
  CX + r * Math.cos((deg * Math.PI) / 180),
  CY + r * Math.sin((deg * Math.PI) / 180)
]
/** An inverted five-pointed star around (0, 0). */
const star = (r: number) =>
  'M' +
  [0, 1, 2, 3, 4]
    .map((i) => {
      const a = Math.PI / 2 + (i * 4 * Math.PI) / 5
      return `${f1(r * Math.cos(a))} ${f1(r * Math.sin(a))}`
    })
    .join('L') +
  'Z'

const STAR = star(4.4)
function Sigil({ i }: { i: number }) {
  switch (i % 5) {
    case 0:
      return <path d="M0 3.4C-6.2-1.4-3.4-6.4 0-3C3.4-6.4 6.2-1.4 0 3.4Z" />
    case 1:
      return (
        <>
          <circle cx="0" cy="1.6" r="2.5" />
          <circle cx="-2.8" cy="-1.5" r="1.15" />
          <circle cx="-1" cy="-3.3" r="1.15" />
          <circle cx="1" cy="-3.3" r="1.15" />
          <circle cx="2.8" cy="-1.5" r="1.15" />
        </>
      )
    case 2:
      return <path d={STAR} fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    case 3:
      return <path d="M1.6-4.2A4.4 4.4 0 1 0 1.6 4.2A3.3 3.3 0 1 1 1.6-4.2Z" />
    default:
      return (
        <>
          <path
            d="M-4.6 0H3M-2.6-2.4V2.4M-.6-2.8V2.8M1.4-2.4V2.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="round"
          />
          <path d="M3 0L5.6-2.6V2.6Z" />
        </>
      )
  }
}

const SIGIL_COUNT = 30
const SIGILS = Array.from({ length: SIGIL_COUNT }, (_, i) => -90 + (i * 360) / SIGIL_COUNT)
  // The kitten sits on top.
  .map((deg, i) => ({ deg, i }))
  .filter(({ deg }) => Math.abs(deg + 90) >= 20)

const TAIL_R = R_OUT + 9
const [tailX, tailY] = pt(38, TAIL_R)
const TAIL = `M174 60C186 56 194 60 ${pt(-62, TAIL_R).map(f1).join(' ')}A${TAIL_R} ${TAIL_R} 0 0 1 ${f1(tailX)} ${f1(tailY)}c-3 6-9 9-14 8`
const BELL_Y = CY + R_OUT

const FUR = '#2a1d42'
const ROSE = '#f5c2e0'

function Kitten() {
  return (
    <g className="couch__kit" transform="translate(150 72) scale(1.4) translate(-150 -72)">
      <g className="couch__kit-wings" fill="#34285a" stroke={ROSE} strokeWidth="1.4" strokeLinejoin="round">
        <path className="is-l" d="M136 58C122 46 108 44 100 50c6 2 8 6 7 10c4-3 8-2 10 2c3-4 8-4 11-1c2-2 5-3 8-3Z" />
        <path className="is-r" d="M164 58C178 46 192 44 200 50c-6 2-8 6-7 10c-4-3-8-2-10 2c-3-4-8-4-11-1c-2-2-5-3-8-3Z" />
      </g>
      <g fill={FUR} stroke={ROSE} strokeWidth="1.6" strokeLinejoin="round">
        <ellipse cx="150" cy="60" rx="27" ry="13" />
        <path d="M131 23L127 6L141 15Z" />
        <path d="M169 23L173 6L159 15Z" />
      </g>
      <path d="M131.5 17L129.5 10L136 14Z M168.5 17L170.5 10L164 14Z" fill="#ff7aab" />
      <ellipse cx="150" cy="34" rx="22" ry="18.5" fill={FUR} stroke={ROSE} strokeWidth="1.6" />
      <path
        d="M141 17c-2-6 0-10 3-12c-1 4 0 7 2 10Z M159 17c2-6 0-10-3-12c1 4 0 7-2 10Z"
        fill="#ff5c9a"
        stroke="#b8285f"
        strokeWidth=".8"
      />
      <path
        className="couch__kit-shut"
        d="M138 34q4 3.5 8 0M154 34q4 3.5 8 0"
        fill="none"
        stroke={ROSE}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        className="couch__kit-happy"
        d="M137.6 35.6L142 30.6L146.4 35.6M153.6 35.6L158 30.6L162.4 35.6"
        fill="none"
        stroke="#ffd27a"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <ellipse cx="134.5" cy="40" rx="3.6" ry="2" fill="#ff5f99" opacity=".55" />
      <ellipse cx="165.5" cy="40" rx="3.6" ry="2" fill="#ff5f99" opacity=".55" />
      <path d="M148.4 38.6h3.2l-1.6 1.8Z" fill="#ff7aab" />
      <path d="M145.5 41.5q2.2 2.2 4.5 0q2.3 2.2 4.5 0" fill="none" stroke={ROSE} strokeWidth="1.2" strokeLinecap="round" />
      <path d="M146.6 42.4l.9 2.6l.9-2.2Z M151.6 42.2l.9 2.2l.9-2.6Z" fill="#fff" />
      <path
        d="M128 37l-9-2M128 40.5l-9 1M172 37l9-2M172 40.5l9 1"
        stroke={ROSE}
        strokeWidth=".9"
        strokeLinecap="round"
        opacity=".7"
      />
      <g fill={FUR} stroke={ROSE} strokeWidth="1.4">
        <ellipse cx="139" cy="70" rx="6" ry="4.4" />
        <ellipse cx="161" cy="70" rx="6" ry="4.4" />
      </g>
      <path d="M137 71v2M139.5 71.3v2M158.5 71.3v2M161 71v2" stroke={ROSE} strokeWidth=".8" strokeLinecap="round" opacity=".7" />
      <g className="couch__kit-zzz" fill="#b996ff">
        <text x="176" y="20">
          z
        </text>
        <text x="184" y="10">
          z
        </text>
      </g>
      <g className="couch__kit-sparkle" fill="#ffd27a">
        <path d="M112 26l1.6 4l4 1.6l-4 1.6l-1.6 4l-1.6-4l-4-1.6l4-1.6Z" />
        <path d="M190 22l1.2 3l3 1.2l-3 1.2l-1.2 3l-1.2-3l-3-1.2l3-1.2Z" />
      </g>
    </g>
  )
}

function Frame() {
  return (
    <svg className="couch__frame" viewBox="0 0 300 300" aria-hidden="true">
      <defs>
        <linearGradient id="ck-band" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#34285a" />
          <stop offset="1" stopColor="#1b1430" />
        </linearGradient>
        <radialGradient id="ck-aura" cx="50%" cy="50%" r="50%">
          <stop offset=".6" stopColor="#ff5c9a" stopOpacity="0" />
          <stop offset=".78" stopColor="#ff5c9a" stopOpacity=".35" />
          <stop offset="1" stopColor="#ff5c9a" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g transform={`translate(150 160) scale(${(80 / R_IN).toFixed(4)}) translate(-${CX} -${CY})`}>
        <circle className="couch__aura" cx={CX} cy={CY} r={R_OUT + 30} fill="url(#ck-aura)" />
        <circle cx={CX} cy={CY} r={(R_OUT + R_IN) / 2} fill="none" stroke="url(#ck-band)" strokeWidth={R_OUT - R_IN} />
        <circle cx={CX} cy={CY} r={R_OUT} fill="none" stroke={ROSE} strokeWidth="2" />
        <circle cx={CX} cy={CY} r={R_IN} fill="none" stroke={ROSE} strokeWidth="2" />
        <circle
          cx={CX}
          cy={CY}
          r={R_OUT + 4}
          fill="none"
          stroke="#a582b8"
          strokeWidth="1"
          strokeDasharray="1 5"
          strokeLinecap="round"
        />

        <g className="couch__runes" fill={ROSE} color={ROSE}>
          {SIGILS.map(({ deg, i }) => {
            const [x, y] = pt(deg, R_SIG)
            return (
              <g key={i} transform={`translate(${f1(x)} ${f1(y)}) rotate(${f1(deg + 90)})`}>
                <Sigil i={i} />
              </g>
            )
          })}
        </g>

        <g className="couch__kit-tail">
          <path d={TAIL} fill="none" stroke={FUR} strokeWidth="7" strokeLinecap="round" />
          <path d={TAIL} fill="none" stroke={ROSE} strokeWidth="1.4" strokeLinecap="round" opacity=".9" />
          <path
            transform={`translate(${f1(tailX - 14)} ${f1(tailY + 8)}) rotate(110)`}
            d="M0-9C5-4 7 0 0 5C-7 0-5-4 0-9Z"
            fill="#ff5c9a"
            stroke="#b8285f"
            strokeWidth="1"
          />
        </g>

        <g className="couch__kit-bell">
          <path d={`M150 ${BELL_Y}v6`} stroke={ROSE} strokeWidth="1.6" />
          <circle cx="150" cy={BELL_Y + 15} r="10" fill="#ffd27a" stroke="#b5832e" strokeWidth="1.4" />
          <path d={`M141 ${BELL_Y + 13}h18`} stroke="#b5832e" strokeWidth="1.2" />
          <path
            transform={`translate(150 ${BELL_Y + 18})`}
            d={star(3.6)}
            fill="none"
            stroke="#7a4f12"
            strokeWidth=".9"
            strokeLinejoin="round"
          />
        </g>

        <Kitten />
      </g>
    </svg>
  )
}

export const KittenFrame = memo(Frame)
