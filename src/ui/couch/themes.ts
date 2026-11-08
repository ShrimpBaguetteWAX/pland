import type { OrbPalette } from './bloodOrb'

/*
 * The kitten look's colour themes: the same couch and the same sleepy cloud kitten, in different
 * colours. Each theme gives the page its night colour, the kitten its fur, cap and cloud, the orb
 * its potion and the moons theirs; the rest of the screen (plaques, tablets, panels, text) follows
 * from Kitten.css, where every colour is a variable with the theme's values under
 * [data-kt='<id>'] (Rose is the default there). Rainbow candy also gives each moon its own colour.
 */

export interface KittenTheme {
  id: 'rose' | 'rainbow' | 'cotton' | 'blueberry' | 'snow'
  name: string
  /** The page behind the couch, so an overscroll shows the same night. */
  night: string
  /** Three colours for the switch's little swatch. */
  swatch: [string, string, string]
  kitten: {
    fur: string
    line: string
    /** The ring's rims and sigils. */
    rim: string
    inner: string
    eye: string
    cheek: string
    cap: string
    /** The cap's three stripes (repeated when fewer). */
    stripes: string[]
    cloud: string
    cloudLine: string
    pom: string
    /** The ring's band, top to bottom. */
    band: [string, string]
    aura: string
    dots: string
    tailTip: [string, string]
  }
  orb: OrbPalette
  moon: { l1: string; l2: string; glass: string; rim: string; ready: string }
  /** A potion per moon, in turn (the rainbow); otherwise every moon has the theme's. */
  moonEach?: [string, string][]
}

const calm = { pace: 0.5, calm: 0.65, gloss: true }

export const KITTEN_THEMES: KittenTheme[] = [
  {
    id: 'rose',
    name: 'Rose',
    night: '#1f0f18',
    swatch: ['#f4a6bf', '#ffd6e2', '#d9577f'],
    kitten: {
      fur: '#fff7f9',
      line: '#d48aa6',
      rim: '#f7c6d4',
      inner: '#ffc2d1',
      eye: '#5b2a40',
      cheek: '#ff8fb1',
      cap: '#f4a6bf',
      stripes: ['#fff'],
      cloud: '#ffe9f0',
      cloudLine: '#f7c6d4',
      pom: '#fff',
      band: ['#4a2436', '#2c1622'],
      aura: '#f4789f',
      dots: '#c98aa4',
      tailTip: ['#ff5c9a', '#b8285f']
    },
    orb: {
      glass: ['#3a1c2c', '#140a10'],
      back: 'rgba(255,190,210,.55)',
      body: [
        [0, '#ffe0e9'],
        [0.14, '#f7a3bd'],
        [0.5, '#d9577f'],
        [1, '#4a1026']
      ],
      churn: 'rgba(255,190,210,.1)',
      bubble: 'rgba(255,236,242,.55)',
      sheen: 'rgba(255,224,234,.3)',
      rim: 'rgba(255,200,215,.28)',
      surface: 'rgba(255,232,240,.9)',
      glow: 'rgba(240,120,160,1)',
      shade: 0.5,
      hearts: '#ffe6ee',
      ...calm
    },
    moon: { l1: '#ffd6e2', l2: '#e9628f', glass: '#3b2131', rim: '#f7c6d4', ready: 'rgba(255,150,180,.5)' }
  },
  {
    id: 'rainbow',
    name: 'Rainbow candy',
    night: '#1d1430',
    swatch: ['#ff8fab', '#fff27a', '#7ad7ff'],
    kitten: {
      fur: '#fffafc',
      line: '#c98ab4',
      rim: '#ffd1ea',
      inner: '#ffc2d8',
      eye: '#3d2550',
      cheek: '#ff8fb1',
      cap: '#ffffff',
      stripes: ['#ff8fab', '#fff27a', '#7ad7ff'],
      cloud: '#fff2fa',
      cloudLine: '#ffd1ea',
      pom: '#ffd36b',
      band: ['#3a2b5e', '#221838'],
      aura: '#ff8fab',
      dots: '#b69cff',
      tailTip: ['#7ad7ff', '#3f8fc0']
    },
    orb: {
      glass: ['#2a1f45', '#120b20'],
      back: 'rgba(255,200,230,.5)',
      body: [
        [0, '#ff8fab'],
        [0.2, '#ffc46b'],
        [0.4, '#fff27a'],
        [0.6, '#8ef0b0'],
        [0.8, '#7ad7ff'],
        [1, '#8f6bff']
      ],
      churn: 'rgba(255,255,255,.08)',
      bubble: 'rgba(255,255,255,.55)',
      sheen: 'rgba(255,255,255,.3)',
      rim: 'rgba(255,220,240,.3)',
      surface: 'rgba(255,240,250,.9)',
      glow: 'rgba(255,160,200,1)',
      shade: 0.3,
      hearts: '#fff6fb',
      ...calm
    },
    moon: { l1: '#ffc2d1', l2: '#ff6f9a', glass: '#2a1f45', rim: '#ffd1ea', ready: 'rgba(255,200,120,.55)' },
    moonEach: [
      ['#ffc2d1', '#ff6f9a'],
      ['#ffe2b0', '#ffa94d'],
      ['#fff6b0', '#f5d63d'],
      ['#c8f9da', '#4fd18b'],
      ['#c4ecff', '#3fb4f0'],
      ['#ddd0ff', '#8f6bff']
    ]
  },
  {
    id: 'cotton',
    name: 'Cotton candy',
    night: '#14203a',
    swatch: ['#ffb8d9', '#fff', '#9fd8ff'],
    kitten: {
      fur: '#fffbfe',
      line: '#a9a8d6',
      rim: '#ffd1e8',
      inner: '#ffc2dd',
      eye: '#26304f',
      cheek: '#ff9fc6',
      cap: '#9fd8ff',
      stripes: ['#ffb8d9'],
      cloud: '#fff4fa',
      cloudLine: '#cfe8ff',
      pom: '#ffb8d9',
      band: ['#26385e', '#18243f'],
      aura: '#ffb8d9',
      dots: '#9fb9ec',
      tailTip: ['#ffb8d9', '#d16a9c']
    },
    orb: {
      glass: ['#22325a', '#0d1428'],
      back: 'rgba(255,200,230,.5)',
      body: [
        [0, '#ffe0f0'],
        [0.18, '#ffb8d9'],
        [0.55, '#9fd8ff'],
        [1, '#2b4a8a']
      ],
      churn: 'rgba(255,220,240,.1)',
      bubble: 'rgba(255,245,252,.55)',
      sheen: 'rgba(255,235,248,.3)',
      rim: 'rgba(220,235,255,.3)',
      surface: 'rgba(255,240,250,.9)',
      glow: 'rgba(255,170,215,1)',
      shade: 0.4,
      hearts: '#fff0f8',
      ...calm
    },
    moon: { l1: '#ffd1e8', l2: '#7cc4ff', glass: '#1f2d4c', rim: '#ffd1e8', ready: 'rgba(255,184,217,.5)' }
  },
  {
    id: 'blueberry',
    name: 'Blueberry night',
    night: '#0c1028',
    swatch: ['#9db4ff', '#d6deff', '#4a5bd6'],
    kitten: {
      fur: '#fbfcff',
      line: '#8f9bd0',
      rim: '#c5d0ff',
      inner: '#ffc8dc',
      eye: '#1c2350',
      cheek: '#ff9fbf',
      cap: '#9db4ff',
      stripes: ['#fff'],
      cloud: '#eef2ff',
      cloudLine: '#c5d0ff',
      pom: '#fff',
      band: ['#222c66', '#141a3e'],
      aura: '#9db4ff',
      dots: '#8f9bd0',
      tailTip: ['#9db4ff', '#4a5bd6']
    },
    orb: {
      glass: ['#1d2450', '#0a0d22'],
      back: 'rgba(170,190,255,.5)',
      body: [
        [0, '#e0e6ff'],
        [0.15, '#9db4ff'],
        [0.5, '#4a5bd6'],
        [1, '#141a4a']
      ],
      churn: 'rgba(170,190,255,.1)',
      bubble: 'rgba(235,240,255,.55)',
      sheen: 'rgba(220,228,255,.3)',
      rim: 'rgba(190,205,255,.28)',
      surface: 'rgba(230,236,255,.9)',
      glow: 'rgba(130,150,255,1)',
      shade: 0.5,
      hearts: '#e6ecff',
      ...calm
    },
    moon: { l1: '#d6deff', l2: '#4a5bd6', glass: '#161c40', rim: '#c5d0ff', ready: 'rgba(140,160,255,.5)' }
  },
  {
    id: 'snow',
    name: 'Snow day',
    night: '#eef4fb',
    swatch: ['#a9c8ff', '#ffffff', '#9a8cf0'],
    kitten: {
      fur: '#ffffff',
      line: '#8a9cc4',
      rim: '#8aa6e0',
      inner: '#ffd0dc',
      eye: '#24324d',
      cheek: '#ff9fb6',
      cap: '#a9c8ff',
      stripes: ['#fff'],
      cloud: '#ffffff',
      cloudLine: '#bcd0f2',
      pom: '#fff',
      band: ['#dfe9fa', '#cfdcf3'],
      aura: '#a9c8ff',
      dots: '#9fb9ec',
      tailTip: ['#a9c8ff', '#5a7fd6']
    },
    orb: {
      glass: ['#f6f9ff', '#dbe6f7'],
      back: 'rgba(170,200,255,.5)',
      body: [
        [0, '#f2f7ff'],
        [0.15, '#c4d9ff'],
        [0.55, '#9a8cf0'],
        [1, '#5a5fc0']
      ],
      churn: 'rgba(160,180,240,.12)',
      bubble: 'rgba(255,255,255,.7)',
      sheen: 'rgba(255,255,255,.45)',
      rim: 'rgba(150,175,230,.35)',
      surface: 'rgba(255,255,255,.95)',
      glow: 'rgba(150,170,255,1)',
      shade: 0.25,
      hearts: '#ffffff',
      ...calm
    },
    moon: { l1: '#e2edff', l2: '#9a8cf0', glass: '#fbfdff', rim: '#9fb9ec', ready: 'rgba(120,150,240,.4)' }
  }
]

const KEY = 'pd:couch-tint'

export function readTint(): KittenTheme {
  try {
    const id = localStorage.getItem(KEY)
    return KITTEN_THEMES.find((t) => t.id === id) ?? KITTEN_THEMES[0]
  } catch {
    return KITTEN_THEMES[0]
  }
}

export function saveTint(t: KittenTheme) {
  try {
    localStorage.setItem(KEY, t.id)
  } catch {
    // Private mode: it holds for this visit.
  }
}
