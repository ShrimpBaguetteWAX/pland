import { useCallback, useEffect, useRef } from 'react'

/*
 * The blood in Couch mode's orb, drawn on a canvas: two wave layers moving against each other,
 * slow glowing currents inside, bubbles that rise and vanish at the surface, a lit meniscus, a wet
 * sheen just under it, and the edge of the sphere darkening so it reads as a ball of liquid.
 * The level eases toward its target; a tap sloshes it. The palette says what the liquid is (see OrbPalette). Drawn at most ~30 times a second, and only
 * while the tab is visible (requestAnimationFrame stops in a background tab).
 */

/** What the liquid is made of: blood for Infernal; the kitten's potions (with floating hearts and a gloss) are in themes.ts. */
export interface OrbPalette {
  glass: [string, string]
  back: string
  body: [number, string][]
  churn: string
  bubble: string
  sheen: string
  rim: string
  surface: string
  glow: string
  shade: number
  hearts?: string
  gloss?: boolean
  /** How fast everything moves (1 = as drawn); below 1 is calmer. */
  pace?: number
  /** How high the waves stand (1 = as drawn). */
  calm?: number
}

export const BLOOD: OrbPalette = {
  glass: ['#240403', '#080101'],
  back: 'rgba(120,14,8,.85)',
  body: [
    [0, '#b8261a'],
    [0.07, '#850f08'],
    [0.4, '#420504'],
    [1, '#110101']
  ],
  churn: 'rgba(255,45,20,.11)',
  bubble: 'rgba(255,150,120,.35)',
  sheen: 'rgba(255,110,80,.22)',
  rim: 'rgba(255,90,60,.22)',
  surface: 'rgba(255,125,95,.75)',
  glow: 'rgba(255,60,30,1)',
  shade: 0.78
}


const heart = (g: CanvasRenderingContext2D, x: number, y: number, s: number) => {
  g.save()
  g.translate(x, y)
  g.scale(s / 7, s / 7)
  g.beginPath()
  g.moveTo(0, 3.4)
  g.bezierCurveTo(-6.2, -1.4, -3.4, -6.4, 0, -3)
  g.bezierCurveTo(3.4, -6.4, 6.2, -1.4, 0, 3.4)
  g.fill()
  g.restore()
}

interface Liquid {
  level: number
  target: number
  slosh: number
  pal: OrbPalette
  resize: (px: number) => void
  draw: (t: number) => void
}

function createLiquid(canvas: HTMLCanvasElement, pal: OrbPalette): Liquid {
  const g = canvas.getContext('2d')!
  let W = canvas.width
  const bubbles = Array.from({ length: 18 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: Math.random(),
    v: 0.4 + Math.random() * 0.8
  }))
  const hearts = Array.from({ length: 3 }, () => ({
    x: 0.2 + Math.random() * 0.6,
    y: 1 + Math.random(),
    v: 0.6 + Math.random() * 0.5,
    s: Math.random()
  }))
  const surface = (x: number, t: number, base: number, amp: number, k1: number, k2: number, s1: number, s2: number, ph: number) =>
    base + amp * Math.sin((x / W) * Math.PI * 2 * k1 + t * s1 + ph) + amp * 0.45 * Math.sin((x / W) * Math.PI * 2 * k2 - t * s2)

  const o: Liquid = {
    level: 0,
    target: 0,
    slosh: 0,
    pal,
    resize(px) {
      if (px <= 0 || px === W) return
      canvas.width = canvas.height = W = px
    },
    draw(time) {
      const P = o.pal
      const t = time * (P.pace ?? 1)
      o.level += (o.target - o.level) * 0.06 * (P.pace ?? 1)
      o.slosh *= 0.97
      const R = W / 2
      const step = Math.max(4, W / 70)
      g.clearRect(0, 0, W, W)
      g.save()
      g.beginPath()
      g.arc(R, R, R, 0, Math.PI * 2)
      g.clip()

      // The empty glass: almost black, a faint warm glow at the bottom.
      const bg = g.createRadialGradient(R, W * 0.9, 0, R, R, R * 1.1)
      bg.addColorStop(0, P.glass[0])
      bg.addColorStop(1, P.glass[1])
      g.fillStyle = bg
      g.fillRect(0, 0, W, W)

      const lv = Math.max(0, Math.min(1, o.level))
      const base = W * (1.02 - lv * 1.04)
      const amp = W * (0.012 * (P.calm ?? 1) + o.slosh * 0.05) * (lv > 0.97 ? 0.5 : 1)
      const wave = (k1: number, k2: number, s1: number, s2: number, ph: number, dy: number, a: number) => {
        g.beginPath()
        g.moveTo(0, W)
        for (let x = 0; x <= W + step; x += step) g.lineTo(x, surface(x, t, base + dy, amp * a, k1, k2, s1, s2, ph))
        g.lineTo(W, W)
        g.closePath()
      }

      // Back layer: lighter, a little higher, slower.
      wave(1.1, 2.3, 0.9, 1.3, 2, -W * 0.012, 1.2)
      g.fillStyle = P.back
      g.fill()
      // Front body.
      wave(1.6, 3.1, 1.5, 2.1, 0, 0, 1)
      const body = g.createLinearGradient(0, base - amp * 2, 0, W)
      for (const [at, c] of P.body) body.addColorStop(at, c)
      g.fillStyle = body
      g.fill()

      g.save()
      g.clip()
      // Churn: slow glowing currents inside the blood.
      g.globalCompositeOperation = 'lighter'
      for (let i = 0; i < 3; i++) {
        const a = t * (0.25 + i * 0.12) + i * 2.1
        const cx = R + Math.cos(a) * R * 0.45
        const cy = Math.max(base, 0) + (W - base) * (0.45 + 0.25 * Math.sin(a * 1.3))
        const rg = g.createRadialGradient(cx, cy, 0, cx, cy, R * (0.55 + i * 0.12))
        rg.addColorStop(0, P.churn)
        rg.addColorStop(1, 'rgba(0,0,0,0)')
        g.fillStyle = rg
        g.fillRect(0, 0, W, W)
      }
      g.globalCompositeOperation = 'source-over'
      // Bubbles rise and vanish at the surface.
      g.strokeStyle = P.bubble
      g.lineWidth = Math.max(1, W / 400)
      for (const b of bubbles) {
        b.y -= b.v * 0.004
        if (b.y < 0.02) {
          b.y = 1
          b.x = Math.random()
        }
        const by = base + (W - base) * b.y
        if (by < base + 4) continue
        const bx = W * (0.15 + 0.7 * b.x) + Math.sin(t * 2 + b.r * 9) * 3
        g.beginPath()
        g.arc(bx, by, (W / 400) * (1.2 + b.r * 3), 0, Math.PI * 2)
        g.stroke()
      }
      // Hearts drifting up through the potion.
      if (P.hearts) {
        g.fillStyle = P.hearts
        g.globalAlpha = 0.7
        for (const h of hearts) {
          h.y -= h.v * 0.0025
          if (h.y < -0.05) {
            h.y = 1.1
            h.x = 0.2 + Math.random() * 0.6
          }
          const hy = base + (W - base) * h.y
          if (hy < base + 4) continue
          heart(g, W * h.x + Math.sin(t * 1.4 + h.s * 9) * W * 0.02, hy, W * (0.03 + h.s * 0.02))
        }
        g.globalAlpha = 1
      }
      // A wet sheen just under the surface, and a rim of light where the blood meets the glass.
      const sheen = g.createLinearGradient(0, base, 0, base + W * 0.16)
      sheen.addColorStop(0, P.sheen)
      sheen.addColorStop(1, 'rgba(0,0,0,0)')
      g.fillStyle = sheen
      g.fillRect(0, base - amp * 2, W, W * 0.2)
      g.beginPath()
      g.arc(R, R, R - 3, Math.PI * 0.15, Math.PI * 0.85)
      g.strokeStyle = P.rim
      g.lineWidth = W / 130
      g.stroke()
      g.restore()

      // The surface: a lit line with a glow.
      if (lv > 0.02 && lv < 0.995) {
        g.beginPath()
        for (let x = 0; x <= W + step; x += step) {
          const y = surface(x, t, base, amp, 1.6, 3.1, 1.5, 2.1, 0)
          if (x) g.lineTo(x, y)
          else g.moveTo(x, y)
        }
        g.strokeStyle = P.surface
        g.lineWidth = W / 180
        g.shadowColor = P.glow
        g.shadowBlur = W / 34
        g.stroke()
        g.shadowBlur = 0
      }
      // Volume: the edge of the sphere darkens.
      const sh = g.createRadialGradient(R * 0.85, R * 0.75, R * 0.2, R, R, R)
      sh.addColorStop(0, 'rgba(0,0,0,0)')
      sh.addColorStop(0.7, 'rgba(0,0,0,.18)')
      sh.addColorStop(1, `rgba(0,0,0,${P.shade})`)
      g.fillStyle = sh
      g.fillRect(0, 0, W, W)
      // A glossy highlight on the glass, like a sweet.
      if (P.gloss) {
        const gl = g.createLinearGradient(0, 0, W, W)
        gl.addColorStop(0, 'rgba(255,255,255,.24)')
        gl.addColorStop(0.35, 'rgba(255,255,255,0)')
        g.fillStyle = gl
        g.beginPath()
        g.ellipse(R * 0.72, R * 0.5, R * 0.5, R * 0.28, -0.6, 0, Math.PI * 2)
        g.fill()
      }
      g.restore()
    }
  }
  return o
}

/** The canvas ref for the orb, and a slosh for taps. `level` runs from 0 (empty) to 1 (brimming). */
export function useBloodOrb(level: number, pal: OrbPalette = BLOOD) {
  const ref = useRef<HTMLCanvasElement>(null)
  const liquid = useRef<Liquid | null>(null)
  const still = useRef(false)
  const latest = useRef(level)
  latest.current = level
  const latestPal = useRef(pal)
  latestPal.current = pal

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const l = createLiquid(canvas, latestPal.current)
    l.level = l.target = latest.current
    liquid.current = l
    still.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const fit = () => {
      l.resize(Math.round(canvas.clientWidth * Math.min(2, window.devicePixelRatio || 1)))
      if (still.current) l.draw(0)
    }
    const ro = new ResizeObserver(fit)
    ro.observe(canvas)
    fit()
    if (still.current) return () => ro.disconnect()
    let id = 0
    let last = 0
    const t0 = performance.now()
    const frame = (now: number) => {
      id = requestAnimationFrame(frame)
      if (now - last < 32) return
      last = now
      l.draw((now - t0) / 1000)
    }
    id = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(id)
      ro.disconnect()
    }
  }, [])

  useEffect(() => {
    const l = liquid.current
    if (!l) return
    l.target = level
    if (still.current) {
      l.level = level
      l.draw(0)
    }
  }, [level])

  useEffect(() => {
    const l = liquid.current
    if (!l) return
    l.pal = pal
    if (still.current) l.draw(0)
  }, [pal])

  const slosh = useCallback((n = 1) => {
    if (liquid.current) liquid.current.slosh = n
  }, [])
  return { ref, slosh }
}
