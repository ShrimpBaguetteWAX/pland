import { useEffect, useRef, useState } from 'react'

/*
 * Couch mode's chimes: a short sound when a mine is ready and when a division is back, also with
 * the tab in the background. Timers in a background tab can run a minute late, but the audio
 * clock keeps exact time, so each chime is booked on it ahead of time and re-booked whenever the
 * times change. Every sound is made here from oscillators: no files to load.
 */

type Voice = {
  f: number
  type?: OscillatorType
  at?: number
  peak?: number
  attack?: number
  decay?: number
  to?: number
  detune?: number
}

export type ChimeId = 'soft' | 'rise' | 'marimba' | 'glass' | 'coin' | 'bell' | 'pop' | 'gong' | 'kalimba' | 'arp'

export const CHIMES: Record<ChimeId, { name: string; voices: Voice[] }> = {
  soft: {
    name: 'Soft chime',
    voices: [
      { f: 392, decay: 1.4, peak: 0.2 },
      { f: 784, decay: 0.9, peak: 0.04 }
    ]
  },
  rise: {
    name: 'Two-note rise',
    voices: [
      { f: 659, decay: 0.7 },
      { f: 880, at: 0.13, decay: 0.8 }
    ]
  },
  marimba: {
    name: 'Marimba',
    voices: [
      { f: 523, type: 'triangle', decay: 0.45, peak: 0.28 },
      { f: 2093, decay: 0.12, peak: 0.05 }
    ]
  },
  glass: {
    name: 'Glass ping',
    voices: [
      { f: 1318, decay: 1.2, peak: 0.12 },
      { f: 1318, decay: 1.2, peak: 0.08, detune: 9 }
    ]
  },
  coin: {
    name: 'Coin',
    voices: [
      { f: 988, type: 'square', decay: 0.09, peak: 0.07 },
      { f: 1319, type: 'square', at: 0.08, decay: 0.35, peak: 0.07 }
    ]
  },
  bell: {
    name: 'Small bell',
    voices: [
      { f: 740, decay: 1.6, peak: 0.16 },
      { f: 740 * 2.76, decay: 1.1, peak: 0.06 },
      { f: 740 * 5.4, decay: 0.7, peak: 0.03 }
    ]
  },
  pop: { name: 'Bubble', voices: [{ f: 300, to: 900, decay: 0.22, peak: 0.2 }] },
  gong: {
    name: 'Deep gong',
    voices: [
      { f: 110, decay: 2, peak: 0.25, attack: 0.05 },
      { f: 165, decay: 1.6, peak: 0.08, attack: 0.05 },
      { f: 277, decay: 1, peak: 0.04 }
    ]
  },
  kalimba: {
    name: 'Kalimba',
    voices: [
      { f: 587, to: 580, type: 'triangle', decay: 0.7, peak: 0.22 },
      { f: 1174, decay: 0.25, peak: 0.05 }
    ]
  },
  arp: {
    name: 'Little tune',
    voices: [
      { f: 523, decay: 0.5 },
      { f: 659, at: 0.11, decay: 0.5 },
      { f: 784, at: 0.22, decay: 0.8 }
    ]
  }
}

/** Which chime plays for what. */
export const CHIME_FOR: Record<'mine' | 'loop', ChimeId> = { mine: 'glass', loop: 'glass' }

let ctx: AudioContext | null = null
/** The audio context, made (and unlocked) on the first tap that asks for sound. */
export function audio(): AudioContext {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  ctx ??= new Ctor()
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  return ctx
}

/** Plays a chime at an audio-clock time; returns a function that silences it if it hasn't played yet. */
function play(id: ChimeId, when: number): () => void {
  const c = audio()
  const out = c.createGain()
  out.connect(c.destination)
  for (const v of CHIMES[id].voices) {
    const t = when + (v.at ?? 0)
    const decay = v.decay ?? 0.8
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = v.type ?? 'sine'
    o.frequency.setValueAtTime(v.f, t)
    if (v.to) o.frequency.exponentialRampToValueAtTime(v.to, t + Math.min(decay, 0.35))
    o.detune.value = v.detune ?? 0
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(v.peak ?? 0.18, t + (v.attack ?? 0.012))
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay)
    o.connect(g).connect(out)
    o.start(t)
    o.stop(t + decay + 0.05)
  }
  // Re-booking happens right as a time is reached (a division comes back, the mine is ready), so a
  // chime that has started is left to ring out; only ones still ahead are taken back.
  return () => {
    if (c.currentTime < when - 0.05) out.disconnect()
  }
}

/** Plays a chime right away (switching sound on, or a preview). */
export const chimeNow = (id: ChimeId) => play(id, audio().currentTime + 0.03)

const STORE = 'pd:couch:sound'

/** Whether couch mode chimes, remembered per device. */
export function useChimeSetting() {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(STORE) === '1'
    } catch {
      return false
    }
  })
  const set = (next: boolean) => {
    setOn(next)
    try {
      localStorage.setItem(STORE, next ? '1' : '0')
    } catch {
      // Storage blocked: the choice lasts for this visit.
    }
  }
  return [on, set] as const
}

export interface ChimeEvent {
  kind: 'mine' | 'loop'
  /** Wall-clock time (ms) it becomes ready. */
  at: number
}

/** Returns closer together than this ring once. */
const MERGE_MS = 20_000
/** Not booked further ahead than this; booked when it gets closer. */
const HORIZON_MS = 6 * 3600_000

/**
 * Books a chime on the audio clock for every upcoming event while sound is on, and books them again
 * when the events change. Events already past never ring.
 */
export function useChimeSchedule(on: boolean, events: ChimeEvent[]) {
  const cancels = useRef<(() => void)[]>([])
  // Only the times matter: a key that changes when they do, not on every render.
  const key = events
    .map((e) => `${e.kind}:${Math.round(e.at / 1000)}`)
    .sort()
    .join(',')

  useEffect(() => {
    for (const c of cancels.current) c()
    cancels.current = []
    if (!on) return
    const c = audio()
    const now = Date.now()
    const booked: ChimeEvent[] = []
    for (const e of [...events].sort((a, b) => a.at - b.at)) {
      if (e.at <= now + 500 || e.at > now + HORIZON_MS) continue
      if (booked.some((b) => b.kind === e.kind && Math.abs(b.at - e.at) < MERGE_MS)) continue
      booked.push(e)
      cancels.current.push(play(CHIME_FOR[e.kind], c.currentTime + (e.at - now) / 1000))
    }
    return () => {
      for (const x of cancels.current) x()
      cancels.current = []
    }
    // key stands for events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, key])

  // After a reload the browser keeps sound locked until the page is touched, and a tab coming back
  // may find it paused: any tap, or coming back to the tab, wakes it.
  useEffect(() => {
    if (!on) return
    const wake = () => {
      if (document.visibilityState === 'visible') audio()
    }
    document.addEventListener('visibilitychange', wake)
    document.addEventListener('pointerdown', wake)
    return () => {
      document.removeEventListener('visibilitychange', wake)
      document.removeEventListener('pointerdown', wake)
    }
  }, [on])
}
