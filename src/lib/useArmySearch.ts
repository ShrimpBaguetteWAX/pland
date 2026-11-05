import { useCallback, useEffect, useRef, useState } from 'react'

import type { SearchInput, SearchProgress, SearchResult } from './armySearch'
import type { SearchReply, SearchRequest } from './armySearch.worker'

export interface ArmySearchState {
  /** The best army so far while running; the final one when done. */
  result: SearchResult | null
  progress: SearchProgress | null
  running: boolean
  done: boolean
  error: string | null
}

/**
 * Runs the army search in a Web Worker. It starts when `start` is called (a search costs real
 * time, so it is not automatic) and again whenever the input changes afterwards; `stop` ends it,
 * keeping the best army found so far.
 */
export function useArmySearch(input: SearchInput | null) {
  const [state, setState] = useState<ArmySearchState>({ result: null, progress: null, running: false, done: false, error: null })
  const worker = useRef<Worker | null>(null)
  const seq = useRef(0)
  const wanted = useRef(false)
  const latest = useRef(input)
  latest.current = input

  // The input holds fresh objects on every render: key it by what matters.
  const key = input
    ? JSON.stringify([
        Object.values(input.pool).map((list) => list.map((a) => a.assetId)),
        input.existing.map((d) => d.id),
        input.missions.map((m) => m.id),
        input.market.rate,
        input.forgeLevel,
        input.slotsFree,
        input.maxDivisions,
        input.alignMove,
        input.matchWeight === Infinity ? 'inf' : input.matchWeight,
        input.matchGoal,
        input.withinGoalWeight,
        input.anchors,
        input.budgetMs,
        input.phases && Object.values(input.phases).map((v) => (Number.isFinite(v) ? v : 'inf'))
      ])
    : ''

  const stop = useCallback(() => {
    worker.current?.terminate()
    worker.current = null
    wanted.current = false
    setState((s) => ({ ...s, running: false, progress: null, done: !!s.result }))
  }, [])

  const start = useCallback(() => {
    const current = latest.current
    if (!current) return
    worker.current?.terminate()
    const id = ++seq.current
    const w = new Worker(new URL('./armySearch.worker.ts', import.meta.url), { type: 'module' })
    worker.current = w
    wanted.current = true
    setState({ result: null, progress: { phase: 'starting', pct: 0, ms: 0, phaseMs: Infinity, best: 0, moves: 0 }, running: true, done: false, error: null })
    w.onmessage = (e: MessageEvent<SearchReply>) => {
      const r = e.data
      if (r.id !== id) return
      if (r.type === 'progress') setState((s) => ({ ...s, progress: r.progress }))
      else if (r.type === 'best') setState((s) => ({ ...s, result: r.result }))
      else if (r.type === 'done') {
        setState({ result: r.result, progress: null, running: false, done: true, error: null })
        w.terminate()
        if (worker.current === w) worker.current = null
      } else if (r.type === 'error') {
        setState((s) => ({ ...s, running: false, error: r.message }))
        w.terminate()
      }
    }
    w.onerror = (e) => setState((s) => ({ ...s, running: false, error: e.message || 'The search stopped unexpectedly' }))
    const request: SearchRequest = { id, input: current }
    // Development: the last input, for balanceDiagnostics from the console.
    if (import.meta.env.DEV) (window as unknown as { __pdSearchInput?: SearchInput }).__pdSearchInput = current
    w.postMessage(request)
  }, [])

  // A changed input starts over, once a search has been asked for.
  const lastKey = useRef(key)
  useEffect(() => {
    if (lastKey.current === key) return
    lastKey.current = key
    if (wanted.current && latest.current) start()
    else setState({ result: null, progress: null, running: false, done: false, error: null })
  }, [key, start])

  useEffect(() => () => worker.current?.terminate(), [])

  return { ...state, start, stop }
}
