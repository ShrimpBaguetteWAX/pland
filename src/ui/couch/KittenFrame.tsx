import { memo } from 'react'

import { furOf, type Animal } from './animals'
import type { KittenTheme } from './themes'

/*
 * The kitten's frame around Couch mode's orb, in the theme's colours (see themes.ts): a dark band
 * between two metal rims with a dial of tick marks and a glowing arc for how far the orb's mission
 * is (the HUD look), a fluffy white kitten in a striped nightcap napping on a
 * cloud on top, its tail wrapped round the front of the cloud, and a collar bell at the bottom. The
 * napper can also be a fox, a wolf or an owl (see animals.ts), in the same place and pose. The kitten is the
 * status light; its moods are classes on the orb (in CSS): asleep while every division is out, eyes
 * open when one is back or the warband marches, happy with sparkles and a bouncing pompom when the
 * loop is ready.
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

/** The dial: a tick every 6°, a long one every 30°; none under the kitten at the top. */
const TICKS = Array.from({ length: 60 }, (_, i) => ({ deg: -90 + i * 6, long: i % 5 === 0 })).filter(({ deg }) => Math.abs(deg + 90) >= 18)
/** The progress arc runs along the middle of the band. */
const ARC_LEN = 2 * Math.PI * R_SIG

const BELL_Y = CY + R_OUT

/** Cloud nap: a fluffy kitten in a striped nightcap, curled on a cloud on the ring, in the theme's colours. */
type Colours = KittenTheme['kitten']

/** The kitten's head sits at (150, 40), its paws on the ring at y 72; the whole is scaled 1.4 round (150, 72). */
const HY = 40

/** Animal parts are SVG markup built in animals.ts from fixed numbers and theme colours. */
const Svg = ({ html, clip }: { html: string; clip?: string }) => (
  <g clipPath={clip ? `url(#${clip})` : undefined} dangerouslySetInnerHTML={{ __html: html }} />
)

function Kitten({ t, animal }: { t: Colours; animal: Animal }) {
  const a = furOf(animal, t)
  return (
    <g className="couch__kit" transform="translate(150 72) scale(1.4) translate(-150 -72)">
      {/* The cloud it naps on. */}
      <g fill={t.cloud} stroke={t.cloudLine} strokeWidth="1.4">
        {[
          [122, 70, 11],
          [136, 74, 13],
          [152, 76, 14],
          [168, 74, 13],
          [180, 70, 10]
        ].map(([x, y, r]) => (
          <circle key={x} cx={x} cy={y} r={r} />
        ))}
      </g>
      <ellipse cx="150" cy="73" rx="34" ry="7" fill={t.cloud} />
      <ellipse cx="150" cy="61" rx="26" ry="13" fill={a.fur} stroke={a.line} strokeWidth="1.6" />
      <Svg html={animal.back(a, t)} />
      <ellipse cx="150" cy={HY} rx="23" ry="19" fill={a.fur} stroke={a.line} strokeWidth="1.6" />
      {animal.face && (
        <>
          <clipPath id="ck-head">
            <ellipse cx="150" cy={HY} rx="23" ry="19" />
          </clipPath>
          <Svg html={animal.face(a)} clip="ck-head" />
          <ellipse cx="150" cy={HY} rx="23" ry="19" fill="none" stroke={a.line} strokeWidth="1.6" />
        </>
      )}
      {animal.front && <Svg html={animal.front(a)} />}
      {/* Eyes: shut asleep, big and shiny awake, happy ^^ when the loop is ready. */}
      <path
        className="couch__kit-shut"
        d={`M138 ${HY}q4 3.5 8 0M154 ${HY}q4 3.5 8 0`}
        fill="none"
        stroke={t.eye}
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <g className="couch__kit-open">
        <ellipse cx="142" cy={HY} rx="3.8" ry="4.4" fill={t.eye} />
        <ellipse cx="158" cy={HY} rx="3.8" ry="4.4" fill={t.eye} />
        <circle cx="143.4" cy={HY - 1.6} r="1.4" fill="#fff" />
        <circle cx="159.4" cy={HY - 1.6} r="1.4" fill="#fff" />
      </g>
      <path
        className="couch__kit-happy"
        d={`M137.6 ${HY + 1.6}L142 ${HY - 3.4}L146.4 ${HY + 1.6}M153.6 ${HY + 1.6}L158 ${HY - 3.4}L162.4 ${HY + 1.6}`}
        fill="none"
        stroke={t.eye}
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <ellipse cx="134.5" cy={HY + 6} rx="3.8" ry="2.1" fill={t.cheek} opacity=".55" />
      <ellipse cx="165.5" cy={HY + 6} rx="3.8" ry="2.1" fill={t.cheek} opacity=".55" />
      <Svg html={animal.nose(a, t)} />
      {animal.wings ? (
        <>
          <g fill={a.fur2} stroke={a.line} strokeWidth="1.4">
            <ellipse cx="127" cy="62" rx="7" ry="11" transform="rotate(25 127 62)" />
            <ellipse cx="173" cy="62" rx="7" ry="11" transform="rotate(-25 173 62)" />
          </g>
          <g fill="#ffb45c" stroke="#d08a3a" strokeWidth="1">
            <ellipse cx="142" cy="72" rx="4" ry="2.4" />
            <ellipse cx="158" cy="72" rx="4" ry="2.4" />
          </g>
        </>
      ) : (
        <g fill={a.fur} stroke={a.line} strokeWidth="1.4">
          <ellipse cx="139" cy="71" rx="6" ry="4.4" />
          <ellipse cx="161" cy="71" rx="6" ry="4.4" />
        </g>
      )}
      {/* The nightcap, flopping to the side, with stripes and a pompom. */}
      <path
        d="M128.5 26C131 10 160 5 170 19C178 29 184 41 186 52L178 50C176 41 170 32 164 26C152 21 140 22 128.5 26Z"
        fill={t.cap}
        stroke={t.line}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {['M137 21.5C142 14 151 11 158 12', 'M146 24C150 18 158 16 165 18', 'M171 28C176 34 180 41 182 48'].map((d, i) => (
        <path key={d} d={d} fill="none" stroke={t.stripes[i % t.stripes.length]} strokeWidth="2.4" strokeLinecap="round" opacity=".85" />
      ))}
      <circle className="couch__kit-pom" cx="184" cy="54" r="5.4" fill={t.pom} stroke={t.line} strokeWidth="1.2" />
      <g className="couch__kit-zzz" fill={t.line}>
        <text x="108" y="26">
          z
        </text>
        <text x="116" y="16">
          z
        </text>
      </g>
      <g className="couch__kit-sparkle" fill="#ffd27a">
        <path d="M110 22l1.6 4l4 1.6l-4 1.6l-1.6 4l-1.6-4l-4-1.6l4-1.6Z" />
        <path d="M192 16l1.2 3l3 1.2l-3 1.2l-1.2 3l-1.2-3l-3-1.2l3-1.2Z" />
      </g>
    </g>
  )
}

function Frame({ theme, animal, progress = 0 }: { theme: KittenTheme; animal: Animal; progress?: number }) {
  const t = theme.kitten
  const p = Math.max(0, Math.min(1, progress))
  return (
    <svg className="couch__frame" viewBox="0 0 300 300" aria-hidden="true">
      <defs>
        <linearGradient id="ck-band" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={t.band[0]} />
          <stop offset="1" stopColor={t.band[1]} />
        </linearGradient>
        <linearGradient id="ck-metal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={t.rim} />
          <stop offset=".45" stopColor={t.dots} />
          <stop offset=".7" stopColor={t.rim} />
          <stop offset="1" stopColor={t.dots} />
        </linearGradient>
        <radialGradient id="ck-aura" cx="50%" cy="50%" r="50%">
          <stop offset=".6" stopColor={t.aura} stopOpacity="0" />
          <stop offset=".78" stopColor={t.aura} stopOpacity=".35" />
          <stop offset="1" stopColor={t.aura} stopOpacity="0" />
        </radialGradient>
      </defs>
      <g transform={`translate(150 160) scale(${(80 / R_IN).toFixed(4)}) translate(-${CX} -${CY})`}>
        <circle className="couch__aura" cx={CX} cy={CY} r={R_OUT + 30} fill="url(#ck-aura)" />
        <circle cx={CX} cy={CY} r={(R_OUT + R_IN) / 2} fill="none" stroke="url(#ck-band)" strokeWidth={R_OUT - R_IN} />
        <circle cx={CX} cy={CY} r={R_OUT} fill="none" stroke="url(#ck-metal)" strokeWidth="2.8" />
        <circle cx={CX} cy={CY} r={R_IN} fill="none" stroke="url(#ck-metal)" strokeWidth="1.8" />

        <g className="couch__ticks" stroke={t.rim} strokeLinecap="round">
          {TICKS.map(({ deg, long }) => {
            const [x1, y1] = pt(deg, R_IN + 4)
            const [x2, y2] = pt(deg, long ? R_OUT - 4 : R_OUT - 9)
            return <line key={deg} x1={f1(x1)} y1={f1(y1)} x2={f1(x2)} y2={f1(y2)} strokeWidth={long ? 1.8 : 1.1} opacity={long ? 0.75 : 0.45} />
          })}
        </g>

        {/* How far the orb's mission is: a lit arc from the top, clockwise. */}
        {p > 0.005 && (
          <circle
            className="couch__arc"
            cx={CX}
            cy={CY}
            r={R_SIG}
            fill="none"
            stroke={t.aura}
            strokeWidth="4.5"
            strokeLinecap="round"
            strokeDasharray={`${f1(ARC_LEN * p)} ${f1(ARC_LEN)}`}
            transform={`rotate(-90 ${CX} ${CY})`}
          />
        )}

        <g className="couch__kit-bell">
          <path d={`M150 ${BELL_Y}v6`} stroke={t.rim} strokeWidth="1.6" />
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

        <Kitten t={t} animal={animal} />

        {/* The tail, wrapped round the front of the cloud the way a cat sits with its tail round its feet. */}
        <Svg html={animal.tail(furOf(animal, t), t)} />
      </g>
    </svg>
  )
}

export const KittenFrame = memo(Frame)
