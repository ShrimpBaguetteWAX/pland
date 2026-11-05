import { useEffect, useRef, useState } from 'react'

import type { Bundle, SolveInput } from './bundle'
import { solveBundleParallel } from './parallelSolve'
import { Cancelled, SolverPool, poolSize } from './solverPool'

/** Wait this long after the last input change before solving, so typing a number solves once. */
const DEBOUNCE_MS = 300
/** Recent answers by input content: returning to an input already solved is instant. */
const CACHE_SIZE = 12

export interface SolverState {
  bundle: Bundle | null
  solving: boolean
  /** How long the last solve took. */
  ms: number | null
  /** The input the shown bundle answers (null before the first answer). */
  solvedFor: SolveInput | null
}

export interface SolverResult extends SolverState {
  /**
   * The input being solved, as the solver holds it: the first object with the current content.
   * Compare `solvedFor` with this, not with a freshly built input of the same content.
   */
  current: SolveInput | null
}

/**
 * Solves the cheapest bundle for `input` on a pool of Web Workers (see parallelSolve.ts). A new
 * input cancels a solve still running (the pool is replaced), so the answer shown is always for the
 * latest input.
 */
export function useBundleSolver(input: SolveInput | null): SolverResult {
  const [state, setState] = useState<SolverState>({ bundle: null, solving: false, ms: null, solvedFor: null })
  const pool = useRef<SolverPool | null>(null)
  const busy = useRef(false)
  const seq = useRef(0)
  const cache = useRef(new Map<string, { bundle: Bundle | null; ms: number }>())

  useEffect(() => () => pool.current?.terminate(), [])

  // Background refreshes rebuild the input object with the same content (army and player data hold
  // Maps the query cache cannot compare). Restart only when the content changes, or every refresh
  // would cancel a solve in progress.
  const key = input ? JSON.stringify(input) : ''
  const stable = useRef<{ key: string; input: SolveInput | null }>({ key: '', input: null })
  if (stable.current.key !== key) stable.current = { key, input }
  const current = stable.current.input

  useEffect(() => {
    const input = current
    if (!input) {
      setState({ bundle: null, solving: false, ms: null, solvedFor: null })
      return
    }
    const hit = cache.current.get(key)
    if (hit) {
      // Solved before: cancel whatever is running and answer at once.
      ++seq.current
      if (busy.current) {
        pool.current?.terminate()
        pool.current = null
        busy.current = false
      }
      setState({ bundle: hit.bundle, solving: false, ms: hit.ms, solvedFor: input })
      return
    }
    const timer = setTimeout(() => {
      // A pool still solving an older input is thrown away rather than waited for.
      if (busy.current) {
        pool.current?.terminate()
        pool.current = null
      }
      pool.current ??= new SolverPool(poolSize())
      const workers = pool.current
      const id = ++seq.current
      busy.current = true
      setState((s) => ({ ...s, solving: true }))
      // Development only: lets the solver be timed on a real input from the console.
      if (import.meta.env.DEV) (globalThis as { __pdSolveInput?: SolveInput }).__pdSolveInput = input
      const started = performance.now()
      solveBundleParallel(input, workers)
        .then((bundle) => {
          if (id !== seq.current) return
          busy.current = false
          const ms = performance.now() - started
          cache.current.set(key, { bundle, ms })
          if (cache.current.size > CACHE_SIZE) cache.current.delete(cache.current.keys().next().value!)
          setState({ bundle, solving: false, ms, solvedFor: input })
        })
        .catch((err) => {
          if (err instanceof Cancelled || id !== seq.current) return
          busy.current = false
          console.error('Bundle solve failed', err)
          setState((s) => ({ ...s, solving: false }))
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // key is derived from current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  return { ...state, current }
}
