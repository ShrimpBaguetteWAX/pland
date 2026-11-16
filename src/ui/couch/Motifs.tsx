import { memo } from 'react'

import type { KittenTheme } from './themes'

/*
 * The gothic schemes' night: a faint motif behind the orb and slowly drifting particles, drawn once
 * per scheme in a 340 × 740 space that covers the screen (cropped, never stretched). Blood moon: a
 * cratered moon, bats and a cathedral skyline, embers rising. Absinthe crypt: cobwebs in the top
 * corners and mist on the floor, fireflies. Velvet requiem: rose-window tracery and a lace edge,
 * violet dust. Moonlit ossuary: a pointed-arch window and a pale moon, ash falling. Illuminated
 * manuscript: a vine border with gold dots, gold flecks. The particles stop for anyone who prefers
 * less motion (Hud.css).
 */

const f1 = (n: number) => n.toFixed(1)

/** A small fixed random sequence, so the particles sit in the same places every time. */
function seq(seed: number) {
  let x = seed
  return () => (x = (x * 9301 + 49297) % 233280) / 233280
}

function Particles({ kind, colour, count, seed }: { kind: 'rise' | 'fall' | 'drift'; colour: string; count: number; seed: number }) {
  const r = seq(seed)
  return (
    <g className={`cm-fx is-${kind}`} fill={colour}>
      {Array.from({ length: count }, (_, i) => {
        const x = r() * 340
        const y = kind === 'fall' ? r() * 520 : 220 + r() * 520
        const size = 0.6 + r() * 1.6
        const dur = 5 + r() * 7
        const delay = -r() * 10
        return (
          <circle
            key={i}
            cx={f1(x)}
            cy={f1(y)}
            r={size.toFixed(2)}
            style={{ animationDuration: `${dur.toFixed(1)}s`, animationDelay: `${delay.toFixed(1)}s`, filter: `drop-shadow(0 0 ${f1(size * 2)}px ${colour})` }}
          />
        )
      })}
    </g>
  )
}

function Web({ x, y, flip }: { x: number; y: number; flip: boolean }) {
  const spokes = [0, 18, 36, 54, 72, 90].map((d) => (d * Math.PI) / 180)
  return (
    <g transform={`translate(${x} ${y}) scale(${flip ? -1 : 1} 1)`} fill="none" stroke="#c4a662" strokeWidth=".6" opacity=".5">
      {spokes.map((a, i) => (
        <path key={i} d={`M0 0L${f1(Math.cos(a) * 120)} ${f1(Math.sin(a) * 120)}`} />
      ))}
      {[22, 44, 68, 94].map((r) => (
        <path
          key={r}
          d={spokes
            .map((a, i) =>
              i
                ? `Q${f1(Math.cos(a - 0.16) * r * 0.9)} ${f1(Math.sin(a - 0.16) * r * 0.9)} ${f1(Math.cos(a) * r)} ${f1(Math.sin(a) * r)}`
                : `M${f1(Math.cos(a) * r)} ${f1(Math.sin(a) * r)}`
            )
            .join(' ')}
        />
      ))}
    </g>
  )
}

function RoseWindow({ cx, cy, r, colour }: { cx: number; cy: number; r: number; colour: string }) {
  return (
    <g fill="none" stroke={colour} strokeWidth=".7" opacity=".55">
      <circle cx={cx} cy={cy} r={r} />
      <circle cx={cx} cy={cy} r={r * 0.62} />
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i * 30 * Math.PI) / 180
        const b = ((i + 1) * 30 * Math.PI) / 180
        const m = (a + b) / 2
        const p = (ang: number, k: number) => `${f1(cx + Math.cos(ang) * r * k)} ${f1(cy + Math.sin(ang) * r * k)}`
        return (
          <g key={i}>
            <path d={`M${p(a, 0.62)}Q${p(a, 1)} ${p(m, 0.97)}Q${p(b, 1)} ${p(b, 0.62)}`} />
            <circle cx={f1(cx + Math.cos(m) * r * 0.8)} cy={f1(cy + Math.sin(m) * r * 0.8)} r={f1(r * 0.07)} />
          </g>
        )
      })}
    </g>
  )
}

const SKYLINE =
  'M0 740V640h18v-30l9-26 9 26v30h20v-60l14-40 14 40v60h16v-18h22v-56l11-34 11 34v56h18v-90l18-58 18 58v90h16v-40l10-30 10 30v40h22v-62l12-40 12 40v62h18v-34l9-26 9 26v34h22V740Z'
const BAT = 'M0 0q-6-6-12-2q4 0 5 4q-4-1-7 2q6 0 8 3q2-4 6-7q4 3 6 7q2-3 8-3q-3-3-7-2q1-4 5-4q-6-4-12 2z'

function BloodMoon() {
  return (
    <>
      <circle cx="64" cy="212" r="36" fill="#9a1022" opacity=".5" />
      <circle cx="64" cy="212" r="36" fill="none" stroke="#ff8a8a" strokeWidth="1" opacity=".4" />
      <circle cx="64" cy="212" r="45" fill="none" stroke="#ff4a5a" strokeWidth="8" opacity=".07" />
      <g fill="#5a0812" opacity=".55">
        <circle cx="52" cy="202" r="6.5" />
        <circle cx="76" cy="224" r="4.5" />
        <circle cx="79" cy="200" r="2.6" />
        <circle cx="57" cy="227" r="3.2" />
      </g>
      {[
        [118, 196, 0.8],
        [148, 214, 0.55],
        [262, 186, 0.7],
        [300, 204, 0.5]
      ].map(([x, y, s]) => (
        <path key={x} transform={`translate(${x} ${y}) scale(${s})`} d={BAT} fill="#0a0204" />
      ))}
      <path d={SKYLINE} fill="#0d0306" opacity=".9" />
      <Particles kind="rise" colour="#ff7a3d" count={26} seed={3} />
    </>
  )
}

function Absinthe() {
  return (
    <>
      <Web x={0} y={0} flip={false} />
      <Web x={340} y={0} flip={true} />
      <ellipse cx="170" cy="720" rx="220" ry="60" fill="#5fae3a" opacity=".12" />
      <ellipse cx="90" cy="690" rx="120" ry="30" fill="#7fd13b" opacity=".07" />
      <Particles kind="drift" colour="#c6ff6a" count={18} seed={11} />
    </>
  )
}

function Velvet() {
  return (
    <>
      <RoseWindow cx={170} cy={350} r={170} colour="#cdb8ea" />
      <g fill="none" stroke="#cdb8ea" strokeWidth=".6" opacity=".4">
        {Array.from({ length: 14 }, (_, i) => (
          <path key={i} d={`M${i * 26} 4q13 16 26 0`} />
        ))}
      </g>
      <Particles kind="drift" colour="#d6a6ff" count={22} seed={5} />
    </>
  )
}

function Ossuary() {
  const cx = 170
  const cy = 350
  const w = 300
  const h = 420
  return (
    <>
      <g fill="none" stroke="#e4ddc9" strokeWidth=".8" opacity=".5">
        <path d={`M${cx - w / 2} ${cy + h / 2}V${cy - h * 0.15}Q${cx - w / 2} ${cy - h / 2} ${cx} ${cy - h * 0.62}Q${cx + w / 2} ${cy - h / 2} ${cx + w / 2} ${cy - h * 0.15}V${cy + h / 2}`} />
        <path d={`M${cx - w / 2 + 10} ${cy + h / 2}V${cy - h * 0.12}Q${cx - w / 2 + 10} ${cy - h * 0.45} ${cx} ${cy - h * 0.55}Q${cx + w / 2 - 10} ${cy - h * 0.45} ${cx + w / 2 - 10} ${cy - h * 0.12}V${cy + h / 2}`} />
        <path d={`M${cx} ${cy - h * 0.55}V${cy + h / 2}`} strokeDasharray="2 4" />
      </g>
      <circle cx="62" cy="80" r="26" fill="#dfe6f0" opacity=".2" />
      <circle cx="62" cy="80" r="40" fill="#dfe6f0" opacity=".05" />
      <Particles kind="fall" colour="#dfe6f0" count={30} seed={9} />
    </>
  )
}

function Manuscript() {
  const r = seq(7)
  const leaves: JSX.Element[] = []
  for (let y = 70; y < 720; y += 46)
    for (const x of [10.5, 329.5]) {
      const dir = x < 100 ? 1 : -1
      leaves.push(
        <g key={`${x}-${y}`}>
          <path d={`M${x} ${y}q${8 * dir} -10 ${16 * dir} -4q${-6 * dir} 8 ${-16 * dir} 4z`} fill="#3f6b2a" opacity=".55" />
          <circle cx={x + 6 * dir} cy={y + 14} r={f1(1.4 + r())} fill="#d9a640" opacity=".85" />
        </g>
      )
    }
  return (
    <>
      <rect x="8" y="8" width="324" height="724" rx="16" fill="none" stroke="#b8862e" strokeWidth="1.4" opacity=".7" />
      <rect x="13" y="13" width="314" height="714" rx="13" fill="none" stroke="#8e1b1b" strokeWidth=".7" opacity=".55" />
      {leaves}
      <g fill="#d9a640" opacity=".85">
        <path d="M14 14h10l-10 10z" />
        <path d="M326 14h-10l10 10z" />
        <path d="M14 726h10l-10-10z" />
        <path d="M326 726h-10l10-10z" />
      </g>
      <Particles kind="drift" colour="#d9a640" count={14} seed={13} />
    </>
  )
}

const MOTIF: Partial<Record<KittenTheme['id'], () => JSX.Element>> = {
  bloodmoon: BloodMoon,
  absinthe: Absinthe,
  velvet: Velvet,
  ossuary: Ossuary,
  manuscript: Manuscript
}

function MotifsView({ id }: { id: KittenTheme['id'] }) {
  const Draw = MOTIF[id]
  if (!Draw) return null
  return (
    <svg className="couch__motif" viewBox="0 0 340 740" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <Draw />
    </svg>
  )
}

export const Motifs = memo(MotifsView)
