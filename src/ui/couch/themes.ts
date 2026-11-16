import type { OrbPalette } from './bloodOrb'

/*
 * The kitten look's colour themes: the same couch and the same sleepy cloud kitten, in different
 * colours. Each theme gives the page its night colour, the kitten its fur, cap and cloud, the orb
 * its potion and the moons theirs; the rest of the screen (plaques, tablets, panels, text) is in
 * Kitten.css under [data-kt='<id>'], with the colours of the theme's stylesheet (Rose is the
 * default there). Rainbow candy also gives each moon its own colour. The five gothic schemes (Blood
 * moon, Absinthe crypt, Velvet requiem, Moonlit ossuary, Illuminated manuscript) add a night motif,
 * drifting particles and their own display type (couch/Motifs.tsx and Hud.css).
 */

export interface KittenTheme {
  id: 'rose' | 'rainbow' | 'cotton' | 'blueberry' | 'snow' | 'bloodmoon' | 'absinthe' | 'velvet' | 'ossuary' | 'manuscript'
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
  /** The moons' potion (top, middle when it has one, bottom), glass, rim and ready glow. */
  moon: { l1: string; mid?: string; l2: string; glass: string; rim: string; ready: string }
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
      glass: ['#2a1f45', '#2a1f45'],
      back: 'rgba(255, 143, 171, 0.5)',
      body: [
        [0, '#ff8fab'],
        [0.2, '#ffc46b'],
        [0.4, '#fff27a'],
        [0.6, '#8ef0b0'],
        [0.8, '#7ad7ff'],
        [1, '#b69cff']
      ],
      churn: 'rgba(255,255,255,.07)',
      bubble: 'rgba(255,255,255,.55)',
      sheen: 'rgba(255,255,255,.3)',
      rim: 'rgba(255, 209, 234, 0.35)',
      surface: 'rgba(255,255,255,.85)',
      glow: 'rgba(182, 156, 255, 1)',
      shade: 0.12,
      hearts: '#ffffff',
      ...calm
    },
    moon: { l1: '#ffc2d1', l2: '#ff6f9a', glass: '#2a1f45', rim: '#ffd1ea', ready: 'rgba(255, 200, 120, 0.55)' },
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
      glass: ['#1f2d4c', '#1f2d4c'],
      back: 'rgba(255, 209, 232, 0.5)',
      body: [
        [0, '#ffd1e8'],
        [0.5, '#ffb8d9'],
        [1, '#9fd8ff']
      ],
      churn: 'rgba(255,255,255,.07)',
      bubble: 'rgba(255,255,255,.55)',
      sheen: 'rgba(255,255,255,.3)',
      rim: 'rgba(255, 209, 232, 0.35)',
      surface: 'rgba(255,255,255,.85)',
      glow: 'rgba(159, 216, 255, 1)',
      shade: 0.12,
      hearts: '#ffffff',
      ...calm
    },
    moon: { l1: '#ffd1e8', mid: '#ffb8d9', l2: '#9fd8ff', glass: '#1f2d4c', rim: '#ffd1e8', ready: 'rgba(255, 184, 217, 0.5)' }
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
      glass: ['#161c40', '#161c40'],
      back: 'rgba(214, 222, 255, 0.5)',
      body: [
        [0, '#d6deff'],
        [0.5, '#9db4ff'],
        [1, '#4a5bd6']
      ],
      churn: 'rgba(255,255,255,.07)',
      bubble: 'rgba(255,255,255,.55)',
      sheen: 'rgba(255,255,255,.3)',
      rim: 'rgba(197, 208, 255, 0.35)',
      surface: 'rgba(255,255,255,.85)',
      glow: 'rgba(74, 91, 214, 1)',
      shade: 0.12,
      hearts: '#ffffff',
      ...calm
    },
    moon: { l1: '#d6deff', mid: '#9db4ff', l2: '#4a5bd6', glass: '#161c40', rim: '#c5d0ff', ready: 'rgba(140, 160, 255, 0.5)' }
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
      glass: ['#fbfdff', '#fbfdff'],
      back: 'rgba(226, 237, 255, 0.5)',
      body: [
        [0, '#e2edff'],
        [0.5, '#a9c8ff'],
        [1, '#9a8cf0']
      ],
      churn: 'rgba(255,255,255,.07)',
      bubble: 'rgba(255,255,255,.55)',
      sheen: 'rgba(255,255,255,.3)',
      rim: 'rgba(159, 185, 236, 0.35)',
      surface: 'rgba(255,255,255,.85)',
      glow: 'rgba(154, 140, 240, 1)',
      shade: 0.12,
      hearts: '#ffffff',
      ...calm
    },
    moon: { l1: '#e2edff', mid: '#a9c8ff', l2: '#9a8cf0', glass: '#fbfdff', rim: '#9fb9ec', ready: 'rgba(120, 150, 240, 0.4)' }
  },
  {
    id: 'bloodmoon',
    name: 'Blood moon',
    night: '#070203',
    swatch: ['#c4122f', '#d8d8e2', '#24181d'],
    kitten: {
      fur: '#24181d',
      line: '#76606a',
      rim: '#d8d8e2',
      inner: '#8a1828',
      eye: '#ff6a2a',
      cheek: '#c4122f',
      cap: '#7a0c1c',
      stripes: ['#d8d8e2'],
      cloud: '#3a2a30',
      cloudLine: '#6e5560',
      pom: '#d8d8e2',
      band: ['#2a0a10', '#120406'],
      aura: '#ff3348',
      dots: '#6b6b78',
      tailTip: ['#e0263f', '#5a0410']
    },
    orb: {
      glass: ['#330c14', '#080203'],
      back: 'rgba(255, 90, 106, 0.5)',
      body: [
        [0, '#ff5a6a'],
        [0.5, '#c4122f'],
        [1, '#5a0410']
      ],
      churn: 'rgba(255,255,255,.07)',
      bubble: 'rgba(255,255,255,.5)',
      sheen: 'rgba(255,255,255,.28)',
      rim: 'rgba(216, 216, 226, 0.35)',
      surface: 'rgba(255,255,255,.8)',
      glow: 'rgba(196, 18, 47, 1)',
      shade: 0.14,
      hearts: '#ff5a6a',
      ...calm
    },
    moon: { l1: '#ff5a6a', mid: '#c4122f', l2: '#5a0410', glass: '#080203', rim: '#d8d8e2', ready: 'rgba(255, 51, 72, 0.5)' }
  },
  {
    id: 'absinthe',
    name: 'Absinthe crypt',
    night: '#030806',
    swatch: ['#7fd13b', '#c4a662', '#cfd6cb'],
    kitten: {
      fur: '#cfd6cb',
      line: '#6f7f68',
      rim: '#c4a662',
      inner: '#9fd27a',
      eye: '#1d3a12',
      cheek: '#9fd27a',
      cap: '#1f4a24',
      stripes: ['#c4a662'],
      cloud: '#4a5a4c',
      cloudLine: '#7e8e74',
      pom: '#c4a662',
      band: ['#16261a', '#08110b'],
      aura: '#a6ff4a',
      dots: '#5e4c24',
      tailTip: ['#7fd13b', '#245a0e']
    },
    orb: {
      glass: ['#16301c', '#030806'],
      back: 'rgba(198, 255, 106, 0.5)',
      body: [
        [0, '#c6ff6a'],
        [0.5, '#7fd13b'],
        [1, '#245a0e']
      ],
      churn: 'rgba(255,255,255,.07)',
      bubble: 'rgba(255,255,255,.5)',
      sheen: 'rgba(255,255,255,.28)',
      rim: 'rgba(196, 166, 98, 0.35)',
      surface: 'rgba(255,255,255,.8)',
      glow: 'rgba(127, 209, 59, 1)',
      shade: 0.14,
      hearts: '#c6ff6a',
      ...calm
    },
    moon: { l1: '#c6ff6a', mid: '#7fd13b', l2: '#245a0e', glass: '#030806', rim: '#c4a662', ready: 'rgba(166, 255, 74, 0.45)' }
  },
  {
    id: 'velvet',
    name: 'Velvet requiem',
    night: '#07040b',
    swatch: ['#9b4fd6', '#cdb8ea', '#1c1024'],
    kitten: {
      fur: '#c9bfd6',
      line: '#6c5a8a',
      rim: '#cdb8ea',
      inner: '#9b4fd6',
      eye: '#2a1240',
      cheek: '#b77fe0',
      cap: '#1c1024',
      stripes: ['#9b4fd6'],
      cloud: '#3b2b4e',
      cloudLine: '#6c5a8a',
      pom: '#cdb8ea',
      band: ['#24123a', '#0d0716'],
      aura: '#c58cff',
      dots: '#5c4a7a',
      tailTip: ['#a65ae0', '#3e146a']
    },
    orb: {
      glass: ['#2a1644', '#06030a'],
      back: 'rgba(214, 166, 255, 0.5)',
      body: [
        [0, '#d6a6ff'],
        [0.5, '#9b4fd6'],
        [1, '#3e146a']
      ],
      churn: 'rgba(255,255,255,.07)',
      bubble: 'rgba(255,255,255,.5)',
      sheen: 'rgba(255,255,255,.28)',
      rim: 'rgba(205, 184, 234, 0.35)',
      surface: 'rgba(255,255,255,.8)',
      glow: 'rgba(155, 79, 214, 1)',
      shade: 0.14,
      hearts: '#d6a6ff',
      ...calm
    },
    moon: { l1: '#d6a6ff', mid: '#9b4fd6', l2: '#3e146a', glass: '#06030a', rim: '#cdb8ea', ready: 'rgba(197, 140, 255, 0.5)' }
  },
  {
    id: 'ossuary',
    name: 'Moonlit ossuary',
    night: '#050608',
    swatch: ['#7fb6ff', '#e4ddc9', '#9aa1ad'],
    kitten: {
      fur: '#9aa1ad',
      line: '#4e5564',
      rim: '#e4ddc9',
      inner: '#e4ddc9',
      eye: '#0e1a2e',
      cheek: '#c7d8f0',
      cap: '#2a2f3a',
      stripes: ['#e4ddc9'],
      cloud: '#4a5060',
      cloudLine: '#80889a',
      pom: '#e4ddc9',
      band: ['#1d222c', '#0a0c10'],
      aura: '#a8d0ff',
      dots: '#6c7484',
      tailTip: ['#7fb6ff', '#29466f']
    },
    orb: {
      glass: ['#1e2636', '#04050a'],
      back: 'rgba(210, 230, 255, 0.5)',
      body: [
        [0, '#d2e6ff'],
        [0.5, '#7fb6ff'],
        [1, '#29466f']
      ],
      churn: 'rgba(255,255,255,.07)',
      bubble: 'rgba(255,255,255,.5)',
      sheen: 'rgba(255,255,255,.28)',
      rim: 'rgba(228, 221, 201, 0.35)',
      surface: 'rgba(255,255,255,.8)',
      glow: 'rgba(127, 182, 255, 1)',
      shade: 0.14,
      hearts: '#d2e6ff',
      ...calm
    },
    moon: { l1: '#d2e6ff', mid: '#7fb6ff', l2: '#29466f', glass: '#04050a', rim: '#e4ddc9', ready: 'rgba(168, 208, 255, 0.45)' }
  },
  {
    id: 'manuscript',
    name: 'Illuminated manuscript',
    night: '#e8dcc0',
    swatch: ['#8e1b1b', '#b8862e', '#1f3a6b'],
    kitten: {
      fur: '#fffaf0',
      line: '#5a3e24',
      rim: '#b8862e',
      inner: '#e8b4a0',
      eye: '#2a1d14',
      cheek: '#d98a7a',
      cap: '#1f3a6b',
      stripes: ['#d9a640'],
      cloud: '#fbf4e2',
      cloudLine: '#b8862e',
      pom: '#d9a640',
      band: ['#e6d4ac', '#c9b285'],
      aura: '#8e1b1b',
      dots: '#ecc96e',
      tailTip: ['#8e1b1b', '#4a0808']
    },
    orb: {
      glass: ['#fdf8ea', '#efe3c2'],
      back: 'rgba(192, 57, 43, 0.5)',
      body: [
        [0, '#c0392b'],
        [0.5, '#8e1b1b'],
        [1, '#4a0808']
      ],
      churn: 'rgba(255,255,255,.07)',
      bubble: 'rgba(255,255,255,.5)',
      sheen: 'rgba(255,255,255,.28)',
      rim: 'rgba(184, 134, 46, 0.35)',
      surface: 'rgba(255,255,255,.8)',
      glow: 'rgba(142, 27, 27, 1)',
      shade: 0.14,
      hearts: '#b8862e',
      ...calm
    },
    moon: { l1: '#c0392b', mid: '#8e1b1b', l2: '#4a0808', glass: '#efe3c2', rim: '#b8862e', ready: 'rgba(142, 27, 27, 0.35)' }
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
