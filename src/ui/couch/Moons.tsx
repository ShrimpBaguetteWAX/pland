import { useId } from 'react'

/*
 * The moons around Couch mode's orb: one per mission the player has divisions on. Each fills with
 * the look's liquid as that mission's next division heads home and shows its own timer; it glows
 * when a division there is back. Size is what the mission brings back (its TLM reward × the
 * divisions on it), so the missions that matter most are the biggest. They run clockwise from the
 * soonest back, down the right side from the kitten and up the left; the top stays clear for the
 * kitten (or the horns) and the bottom for the bell. More than eight: the smallest merge into one.
 * The orb itself is the biggest mission, so it is not among these. A tap loops a moon's mission when
 * its divisions are back, and otherwise shows that mission's divisions (the merged moon: all of them).
 */

export interface MoonMission {
  missionId: number
  title: string
  /** Divisions on it, out and back. */
  divs: number
  /** Of those, back and waiting for the loop. */
  back: number
  /** The next return among those still out, and when that division left. */
  next: { joinedAt: number; unlockAt: number } | null
  /** What all of them bring back, in TLM (DEF counted at the pool price). */
  value: number
}

const MAX = 8
/** Where moons may sit, in degrees clockwise from 3 o'clock: right side, then left side. */
const ARCS: [number, number][] = [
  [-50, 64],
  [116, 230]
]
const SPAN = ARCS.reduce((n, [a, b]) => n + (b - a), 0)
const angleAt = (u: number) => {
  let d = u * SPAN
  for (const [a, b] of ARCS) {
    if (d <= b - a) return a + d
    d -= b - a
  }
  return ARCS[ARCS.length - 1][1]
}
/** The orbit's radius and the moons' sizes, in % of the orb box's width (the hole is r 26.7 at 50, 53.3). */
const ORBIT = 45
const MIN_D = 14
const MAX_D = 22

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const x = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`
}

/** Merges the smallest missions into one moon when there are more than fit. */
function fit(list: MoonMission[]): (MoonMission & { more?: number })[] {
  if (list.length <= MAX) return list
  const bySize = [...list].sort((a, b) => b.value - a.value)
  const keep = bySize.slice(0, MAX - 1)
  const rest = bySize.slice(MAX - 1)
  const next = rest.map((m) => m.next).filter((n): n is NonNullable<typeof n> => !!n).sort((a, b) => a.unlockAt - b.unlockAt)[0] ?? null
  return [
    ...keep,
    {
      missionId: -1,
      title: `${rest.length} more missions`,
      divs: rest.reduce((n, m) => n + m.divs, 0),
      back: rest.reduce((n, m) => n + m.back, 0),
      next,
      value: rest.reduce((n, m) => n + m.value, 0),
      more: rest.length
    }
  ]
}

function Moon({
  m,
  x,
  y,
  d,
  now,
  potion,
  onTap
}: {
  m: MoonMission & { more?: number }
  x: number
  y: number
  d: number
  now: number
  /** Its own potion (top, bottom), when the theme gives every moon one. */
  potion?: [string, string]
  onTap: (missionId: number) => void
}) {
  const id = useId().replace(/:/g, '')
  const ready = m.back > 0
  const fill = ready ? 1 : m.next ? Math.min(1, Math.max(0.04, (now - m.next.joinedAt) / Math.max(1, m.next.unlockAt - m.next.joinedAt))) : 0.04
  const time = ready ? 'Ready' : m.next ? clock(m.next.unlockAt - now) : '–'
  // Low, slow swells: one crest every 50 units, a band of light along the top.
  const wave = (y0: number, a: number) => `M-100 ${y0} q25 -${a} 50 0 t50 0 t50 0 t50 0 t50 0 t50 0 V110 H-100 Z`
  return (
    <button
      type="button"
      className={`couch__moon${ready ? ' is-ready' : ''}`}
      style={{ left: `${x}%`, top: `${y}%`, width: `${d}cqw`, ...(potion ? { '--moon-l1': potion[0], '--moon-l2': potion[1] } : {}) } as React.CSSProperties}
      onClick={() => onTap(m.missionId)}
      aria-label={`${m.title}: ${m.divs} division${m.divs === 1 ? '' : 's'}, ${ready ? `${m.back} back` : m.next ? `next back in ${clock(m.next.unlockAt - now)}` : 'none out'}. ${ready && !m.more ? 'Loops it.' : 'Shows its divisions.'}`}
      title={`${m.title} · ${m.divs} division${m.divs === 1 ? '' : 's'} · worth ≈ ${Math.round(m.value).toLocaleString('en-US')} TLM`}
    >
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <clipPath id={`${id}c`}>
            <circle cx="50" cy="50" r="45.5" />
          </clipPath>
          <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="couch__moon-l1" />
            <stop offset=".5" className="couch__moon-lm" />
            <stop offset="1" className="couch__moon-l2" />
          </linearGradient>
        </defs>
        <path className="couch__moon-ear" d="M20 30L17 4L42 14Z M80 30L83 4L58 14Z" />
        <path className="couch__moon-ear-in" d="M23 22L21.5 10L34 15Z M77 22L78.5 10L66 15Z" />
        <circle className="couch__moon-glass" cx="50" cy="50" r="47" />
        <g clipPath={`url(#${id}c)`}>
          <g transform={`translate(0 ${(100 - fill * 100).toFixed(1)})`}>
            <path className="couch__moon-wave is-back" fill={`url(#${id}g)`} d={wave(0, 1.6)} />
            <path className="couch__moon-wave" fill={`url(#${id}g)`} d={wave(2.5, 2.4)} />
            <path className="couch__moon-wave is-sheen" d="M-100 1.5q25-2.4 50 0t50 0t50 0t50 0t50 0t50 0v3.2q-25 2-50 0t-50 0t-50 0t-50 0t-50 0t-50 0Z" />
          </g>
        </g>
        <ellipse className="couch__moon-gloss" cx="36" cy="26" rx="15" ry="8" transform="rotate(-24 36 26)" />
      </svg>
      <span className="couch__moon-txt">
        <b className="num">{m.more ? `+${m.more}` : time}</b>
        {d >= 15 && <small>{m.more ? time : `${m.divs} div`}</small>}
      </span>
    </button>
  )
}

export function Moons({
  missions,
  now,
  each,
  onTap
}: {
  missions: MoonMission[]
  now: number
  /** A potion per moon, in turn (the rainbow theme). */
  each?: [string, string][]
  onTap: (missionId: number) => void
}) {
  const list = fit(missions)
  if (!list.length) return null
  // Soonest back first: those already back, then by their next return.
  const order = [...list].sort((a, b) => (b.back > 0 ? 1 : 0) - (a.back > 0 ? 1 : 0) || (a.next?.unlockAt ?? Infinity) - (b.next?.unlockAt ?? Infinity))
  const values = list.map((m) => Math.sqrt(Math.max(0, m.value)))
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  // Size by area: the diameter grows with the square root of the TLM.
  const size = (m: MoonMission) => (hi - lo < 1e-9 ? (MIN_D + MAX_D) / 2 : MIN_D + ((Math.sqrt(Math.max(0, m.value)) - lo) / (hi - lo)) * (MAX_D - MIN_D))
  return (
    <div className="couch__moons">
      {order.map((m, i) => {
        // Evenly spread, each in the middle of its share: one moon sits at 3 o'clock, two face each other.
        const a = ((order.length === 1 ? 0 : angleAt((i + 0.5) / order.length)) * Math.PI) / 180
        return <Moon key={m.missionId} m={m} x={50 + Math.cos(a) * ORBIT} y={53.33 + Math.sin(a) * ORBIT} d={size(m)} now={now} potion={each ? each[i % each.length] : undefined} onTap={onTap} />
      })}
    </div>
  )
}
