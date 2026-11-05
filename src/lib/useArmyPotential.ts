import { useEffect, useRef, useState } from 'react'

import type { SearchInput, Tried } from './armySearch'
import type { PotentialReply, PotentialRequest } from './armyPotential.worker'

export interface PotentialState {
  tried: Tried[]
  perHour: number | null
  nowPerHour: number | null
  running: boolean
  error: string | null
}

/**
 * What the wallet can field at once (see potentialArmy), worked out in a Web Worker as soon as the
 * input is there and again whenever it changes. Unlike the main search this needs no button: it is
 * the first thing a player wants to know about an army.
 */
export function useArmyPotential(input: SearchInput | null): PotentialState {
  const [state, setState] = useState<PotentialState>({ tried: [], perHour: null, nowPerHour: null, running: false, error: null })
  const seq = useRef(0)
  const latest = useRef(input)
  latest.current = input
  const key = input
    ? JSON.stringify([
        Object.values(input.pool).map((list) => list.map((a) => a.assetId)),
        input.missions.map((m) => m.id),
        input.market.rate,
        input.forgeLevel,
        input.slotsFree,
        input.maxDivisions
      ])
    : ''
  useEffect(() => {
    const current = latest.current
    if (!current) {
      setState({ tried: [], perHour: null, nowPerHour: null, running: false, error: null })
      return
    }
    const id = ++seq.current
    const w = new Worker(new URL('./armyPotential.worker.ts', import.meta.url), { type: 'module' })
    setState((s) => ({ ...s, running: true, error: null }))
    w.onmessage = (e: MessageEvent<PotentialReply>) => {
      const r = e.data
      if (r.id !== id) return
      if (r.type === 'done') setState({ tried: r.tried, perHour: r.perHour, nowPerHour: r.nowPerHour, running: false, error: null })
      else setState((s) => ({ ...s, running: false, error: r.message }))
      w.terminate()
    }
    w.onerror = (e) => setState((s) => ({ ...s, running: false, error: e.message || 'The analysis stopped unexpectedly' }))
    const request: PotentialRequest = { id, input: current }
    w.postMessage(request)
    return () => w.terminate()
    // key stands for the input.
  }, [key])
  return state
}
