import type { KittenTheme } from './themes'

/*
 * Who naps on the cloud: the kitten, the fluffy fox, the wolf or the owl. Each takes the kitten's
 * exact place and pose (same cloud, nightcap, eyes and moods, drawn in KittenFrame); this file only
 * draws what differs: ears and cheek fluff behind the head, face markings, a chest tuft, the nose,
 * paws or folded wings, and the tail wrapped round the front of the cloud. The kitten takes its fur
 * from the colour theme; the others keep their own soft colours. Chosen with the small switch next to
 * the colour swatch and remembered in this browser.
 *
 * The parts are plain SVG markup (made here from numbers, never from data), in the kitten's space:
 * head at (150, 40), scaled 1.4 round (150, 72). Tails are in the frame's space, like the kitten's.
 */

type Colours = KittenTheme['kitten']
type P = [number, number]

export interface Animal {
  id: 'kitten' | 'fox' | 'wolf' | 'owl'
  name: string
  /** Fur, the lighter fur (face, chest, tail tip) and the outline; the kitten's come from the theme. */
  fur?: string
  fur2?: string
  line?: string
  /** Behind the head: ears, cheek fluff. */
  back: (a: Fur, t: Colours) => string
  /** On the face, clipped to the head. */
  face?: (a: Fur) => string
  /** Over the head and body, under the eyes: a chest tuft. */
  front?: (a: Fur) => string
  nose: (a: Fur, t: Colours) => string
  /** Wings folded over the cloud instead of paws. */
  wings?: boolean
  /** In the frame's space, in front of the cloud. */
  tail: (a: Fur, t: Colours) => string
}

/** An animal's colours, with the kitten's filled in from the theme. */
export interface Fur {
  fur: string
  fur2: string
  line: string
}

export function furOf(a: Animal, t: Colours): Fur {
  return { fur: a.fur ?? t.fur, fur2: a.fur2 ?? '#ffffff', line: a.line ?? t.line }
}

const HY = 40
const f = (v: number) => v.toFixed(1)
const mir = (pts: P[]): P[] => pts.map(([x, y]) => [300 - x, y])
const poly = (pts: P[]) => 'M' + pts.map((p) => p.join(' ')).join('L') + 'Z'
const lerp = (a: P, b: P, k: number): P => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]

/** A pair of pointed ears (the left one given, the right mirrored), with an inner colour and optional dark tips. */
function pointy(pts: P[], a: Fur, o: { inner?: string; tip?: string; noInner?: boolean } = {}) {
  const one = (p: P[]) => {
    const [b1, ap, b2] = p
    const inner: P[] = [lerp(b1, ap, 0.25), lerp(ap, lerp(b1, b2, 0.5), 0.22), lerp(b2, ap, 0.25)]
    const tip = o.tip ? `<path d="${poly([ap, lerp(ap, b1, 0.32), lerp(ap, b2, 0.32)])}" fill="${o.tip}"/>` : ''
    return `<path d="${poly(p)}" fill="${a.fur}" stroke="${a.line}" stroke-width="1.6" stroke-linejoin="round"/>${o.noInner ? '' : `<path d="${poly(inner)}" fill="${o.inner}"/>`}${tip}`
  }
  return one(pts) + one(mir(pts))
}

const MASK = 'M124 40C136 42 144 48 150 54C156 48 164 42 176 40V64H124Z'
const WRAP = 'M204 76C198 100 140 104 112 94C100 90 96 80 102 72'
const WRAP_TIP = 'M110 92C101 88 98 79 102 72'

const tube = (d: string, a: Fur, w: number, fill = a.fur) =>
  `<path d="${d}" fill="none" stroke="${a.line}" stroke-width="${w + 2.8}" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="${fill}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`

const dogNose = (nose: string, a: Fur) =>
  `<ellipse cx="150" cy="${HY + 5.5}" rx="3.2" ry="2.3" fill="${nose}"/><path d="M146.5 ${HY + 9}q1.8 1.8 3.5 0q1.7 1.8 3.5 0" fill="none" stroke="${a.line}" stroke-width="1.2" stroke-linecap="round"/>`

/** One soft tuft of fur: from a base (at `inset` along n), curving out to a point `len` out, swept along t, and back. */
function tuft([x, y]: P, [nx, ny]: P, [tx, ty]: P, inset: number, len: number, w: number) {
  const b1: P = [x + nx * inset - tx * w, y + ny * inset - ty * w]
  const b2: P = [x + nx * inset + tx * w, y + ny * inset + ty * w]
  const ap: P = [x + nx * len + tx * len * 0.45, y + ny * len + ty * len * 0.45]
  const c1: P = [b1[0] + nx * len * 0.85, b1[1] + ny * len * 0.85]
  const c2: P = [b2[0] + nx * len * 0.35 + tx * 1.5, b2[1] + ny * len * 0.35 + ty * 1.5]
  return `<path d="M${f(b1[0])} ${f(b1[1])}Q${f(c1[0])} ${f(c1[1])} ${f(ap[0])} ${f(ap[1])}Q${f(c2[0])} ${f(c2[1])} ${f(b2[0])} ${f(b2[1])}Z"/>`
}

/** Draws shapes twice, outlined then plain, so only the outer edge of the whole keeps its line. */
function outlined(shapes: [string, string][], line: string, width: number) {
  const pass = (stroke: boolean) =>
    shapes
      .map(([el, fill]) => el.replace('/>', ` fill="${fill}"${stroke ? ` stroke="${line}" stroke-width="${width}" stroke-linejoin="round"` : ''}/>`))
      .join('')
  return pass(true) + pass(false)
}

/* The wrapped tail's path (WRAP) as its two curves, to sample along. */
const SEGS: [P, P, P, P][] = [
  [[204, 76], [198, 100], [140, 104], [112, 94]],
  [[112, 94], [100, 90], [96, 80], [102, 72]]
]
const bez = (p: P[], u: number): P => {
  const v = 1 - u
  return [0, 1].map((k) => v * v * v * p[0][k] + 3 * v * v * u * p[1][k] + 3 * v * u * u * p[2][k] + u * u * u * p[3][k]) as P
}
const bezD = (p: P[], u: number): P => {
  const v = 1 - u
  return [0, 1].map((k) => 3 * v * v * (p[1][k] - p[0][k]) + 6 * v * u * (p[2][k] - p[1][k]) + 3 * u * u * (p[3][k] - p[2][k])) as P
}
function sampleWrap(n: number) {
  const out: { g: number; x: number; y: number; tx: number; ty: number }[] = []
  for (let i = 0; i <= n; i++) {
    const g = i / n
    const [seg, u] = g < 0.78 ? [SEGS[0], g / 0.78] : [SEGS[1], (g - 0.78) / 0.22]
    const [x, y] = bez(seg, u)
    const [dx, dy] = bezD(seg, u)
    const l = Math.hypot(dx, dy) || 1
    out.push({ g, x, y, tx: dx / l, ty: dy / l })
  }
  return out
}

/** The fox's brush: round and swelling in the middle, soft tufts along both sides, a white tufted tip. */
function fluffyTail(a: Fur) {
  const S = sampleWrap(40)
  const rad = (g: number) => 4.2 + 4.2 * Math.sin(Math.PI * Math.min(1, g * 0.95))
  const col = (g: number) => (g > 0.72 ? a.fur2 : a.fur)
  const shapes: [string, string][] = S.map(({ g, x, y }) => [`<circle cx="${f(x)}" cy="${f(y)}" r="${f(rad(g))}"/>`, col(g)])
  S.forEach(({ g, x, y, tx, ty }, i) => {
    if (i % 5 !== 2 || i > 37) return
    const r = rad(g)
    ;[1, -1].forEach((side, k) => {
      const sh = k ? 2.5 : 0
      shapes.push([tuft([x + tx * sh, y + ty * sh], [-ty * side, tx * side], [tx, ty], r * 0.6, r + 3.2, 4.2), col(g)])
    })
  })
  const e = S[S.length - 1]
  ;[-0.6, 0, 0.6].forEach((k) => {
    const c = Math.cos(k)
    const s = Math.sin(k)
    const dx = e.tx * c - e.ty * s
    const dy = e.tx * s + e.ty * c
    shapes.push([tuft([e.x, e.y], [dx, dy], [-dy, dx], 0, 8.5, 3.6), a.fur2])
  })
  return outlined(shapes, a.line, 2.6)
}

/** Three soft white tufts out of each cheek, curving down and back. */
function cheekRuff(a: Fur) {
  const T: [P, P, P, number, number][] = [
    [[130, 40], [-0.94, 0.34], [0.34, 0.94], 9, 4],
    [[130, 47], [-0.87, 0.5], [0.5, 0.87], 11, 4.4],
    [[134, 53], [-0.6, 0.8], [0.8, 0.6], 10, 4.2]
  ]
  const shapes: [string, string][] = [1, -1].flatMap((s) =>
    T.map(([p, n, t, len, w]): [string, string] => [tuft([s * (p[0] - 150) + 150, p[1]], [s * n[0], n[1]], [s * t[0], t[1]], 0, len, w), a.fur2])
  )
  return outlined(shapes, a.line, 2.4)
}

function earFluff(a: Fur) {
  const L: P[][] = [
    [[133, 26], [128, 14]],
    [[136.5, 24.5], [133, 12]],
    [[140, 22.5], [137.5, 14]]
  ]
  return `<g stroke="${a.fur2}" stroke-width="1.7" stroke-linecap="round">${[...L, ...L.map((s) => mir(s))]
    .map(([p, q]) => `<path d="M${p[0]} ${p[1]}L${q[0]} ${q[1]}"/>`)
    .join('')}</g>`
}

export const ANIMALS: Animal[] = [
  {
    id: 'kitten',
    name: 'Kitten',
    back: (a, t) =>
      `<g fill="${a.fur}" stroke="${a.line}" stroke-width="1.6" stroke-linejoin="round"><path d="M131 ${HY - 12}L127 ${HY - 30}L142 ${HY - 21}Z"/><path d="M169 ${HY - 12}L173 ${HY - 30}L158 ${HY - 21}Z"/></g><path d="M131.7 ${HY - 18}L129.8 ${HY - 26}L137 ${HY - 21.5}Z M168.3 ${HY - 18}L170.2 ${HY - 26}L163 ${HY - 21.5}Z" fill="${t.inner}"/>`,
    nose: (a, t) =>
      `<path d="M148.3 ${HY + 4.4}h3.4l-1.7 1.9Z" fill="${t.cheek}"/><path d="M145.5 ${HY + 7.2}q2.2 2.2 4.5 0q2.3 2.2 4.5 0" fill="none" stroke="${a.line}" stroke-width="1.2" stroke-linecap="round"/><path d="M128 ${HY + 3}l-9-2M128 ${HY + 6.5}l-9 1M172 ${HY + 3}l9-2M172 ${HY + 6.5}l9 1" stroke="${a.line}" stroke-width=".9" stroke-linecap="round" opacity=".7"/>`,
    tail: (a, t) =>
      `${tube(WRAP, a, 6.5)}<circle class="couch__kit-tip" cx="102" cy="72" r="3.6" fill="${t.tailTip[0]}" stroke="${t.tailTip[1]}" stroke-width="1"/>`
  },
  {
    id: 'fox',
    name: 'Fox',
    fur: '#ffb07c',
    fur2: '#fff8f0',
    line: '#d07a55',
    back: (a) => pointy([[130, HY - 12], [122, HY - 37], [144, HY - 22]], a, { tip: '#6b4040', inner: '#ffe3cf' }) + earFluff(a) + cheekRuff(a),
    face: (a) => `<path d="${MASK}" fill="${a.fur2}"/>`,
    front: (a) =>
      `<path d="M136 55L140 66L144.5 61L150 70L155.5 61L160 66L164 55Z" fill="${a.fur2}" stroke="${a.line}" stroke-width="1.4" stroke-linejoin="round"/>`,
    nose: (a) => dogNose('#5b3a3a', a),
    tail: (a) => `<g class="couch__kit-brush">${fluffyTail(a)}</g>`
  },
  {
    id: 'wolf',
    name: 'Wolf',
    fur: '#b8bdd3',
    fur2: '#f4f5fb',
    line: '#7f86a6',
    back: (a) => pointy([[130, HY - 12], [126, HY - 33], [143, HY - 21]], a, { inner: '#e4e6f2' }),
    face: (a) =>
      `<path d="${MASK}" fill="${a.fur2}"/><ellipse cx="141" cy="${HY - 7}" rx="4" ry="2" fill="${a.fur2}"/><ellipse cx="159" cy="${HY - 7}" rx="4" ry="2" fill="${a.fur2}"/>`,
    nose: (a) => dogNose('#3e4258', a),
    tail: (a) =>
      `<g class="couch__kit-brush">${tube(WRAP, a, 10)}<path d="${WRAP_TIP}" fill="none" stroke="#7d84a3" stroke-width="10" stroke-linecap="round"/></g>`
  },
  {
    id: 'owl',
    name: 'Owl',
    fur: '#d9b892',
    fur2: '#f7ead8',
    line: '#a98560',
    back: (a) => pointy([[133, HY - 10], [124, HY - 28], [142, HY - 18]], a, { noInner: true }),
    face: (a) => `<circle cx="141" cy="${HY}" r="9.5" fill="${a.fur2}"/><circle cx="159" cy="${HY}" r="9.5" fill="${a.fur2}"/>`,
    nose: () => `<path d="M147 ${HY + 3}L153 ${HY + 3}L150 ${HY + 9}Z" fill="#ffb45c" stroke="#d08a3a" stroke-width="1" stroke-linejoin="round"/>`,
    wings: true,
    tail: () => ''
  }
]

const KEY = 'pd:couch-animal'

export function readAnimal(): Animal {
  try {
    const id = localStorage.getItem(KEY)
    return ANIMALS.find((a) => a.id === id) ?? ANIMALS[0]
  } catch {
    return ANIMALS[0]
  }
}

export function saveAnimal(a: Animal) {
  try {
    localStorage.setItem(KEY, a.id)
  } catch {
    // Private mode: it holds for this visit.
  }
}
