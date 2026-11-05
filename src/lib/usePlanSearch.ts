import { useCallback, useEffect, useRef, useState } from 'react'

import type { Bundle } from './bundle'
import { solveBundleParallel } from './parallelSolve'
import { Cancelled, SolverPool, poolSize } from './solverPool'
import { fasterOf, type PlanScenario } from './upgradePlans'

/*
 * Solves the Upgrade tab's whole-division scenarios one after another on the solver's worker pool
 * (each solve is itself spread over the workers), reporting progress as it goes. Answers are kept
 * per data snapshot for the session, so coming back to the tab shows them at once.
 */

export interface SolvedScenario {
  scenario: PlanScenario
  bundle: Bundle
}

interface Search {
  solved: SolvedScenario[]
  done: number
  total: number
  finished: boolean
  /** The plan being worked on now. */
  working: PlanScenario | null
}

const memory = new Map<string, Search>()
/** A plan that takes longer than this is skipped, so one huge division cannot hold up the rest. */
const PLAN_BUDGET_MS = 45_000

export function usePlanSearch(key: string | null, scenarios: PlanScenario[] | null) {
  const [state, setState] = useState<Search>(
    () => (key && memory.get(key)) || { solved: [], done: 0, total: 0, finished: false, working: null }
  )
  const [round, setRound] = useState(0)
  const latest = useRef(scenarios)
  latest.current = scenarios

  useEffect(() => {
    const list = latest.current
    if (!key || !list) return
    const kept = memory.get(key)
    if (kept?.finished && round === 0) {
      setState(kept)
      return
    }
    let cancelled = false
    let pool = new SolverPool(poolSize())
    const queue = [...list]
    let search: Search = { solved: [], done: 0, total: queue.length, finished: false, working: null }
    setState(search)
    void (async () => {
      while (queue.length && !cancelled) {
        const s = queue.shift()!
        search = { ...search, working: s }
        setState(search)
        let bundle: Bundle | null = null
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), PLAN_BUDGET_MS)))
          // A pool thrown away (timeout or leaving the tab) rejects its solve with Cancelled: that is no answer.
          const solving = solveBundleParallel(s.input, pool).catch((e) => {
            if (e instanceof Cancelled) return null
            throw e
          })
          const got = await Promise.race([solving, late])
          if (got === 'late') {
            // Throw the busy workers away and carry on with fresh ones.
            pool.terminate()
            pool = new SolverPool(poolSize())
          } else bundle = got
        } catch (err) {
          console.error('Upgrade plan solve failed', s.id, err)
        } finally {
          clearTimeout(timer)
        }
        if (cancelled) return
        const faster = bundle ? fasterOf(s, bundle) : null
        if (faster) queue.unshift(faster)
        search = {
          solved: bundle ? [...search.solved, { scenario: s, bundle }] : search.solved,
          done: search.done + 1,
          total: search.total + (faster ? 1 : 0),
          finished: queue.length === 0,
          working: null
        }
        memory.set(key, search)
        setState(search)
      }
    })()
    return () => {
      cancelled = true
      pool.terminate()
    }
  }, [key, round])

  const again = useCallback(() => {
    if (key) memory.delete(key)
    setRound((r) => r + 1)
  }, [key])

  return { ...state, again }
}
