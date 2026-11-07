import { useCallback, useEffect, useRef, useState } from 'react'

import type { SearchInput, SearchProgress, SearchResult } from './armySearch'
import type { SearchReply, SearchRequest } from './armySearch.worker'

/** One seed's run: its best answer so far, how far it is, whether it finished. */
export interface SeedRun {
  seed: number
  result: SearchResult | null
  progress: SearchProgress | null
  done: boolean
}

export interface ArmySearchState {
  /** The best army so far across every seed while running; the best final one when done. */
  result: SearchResult | null
  /** The progress of the seed that is furthest behind, with moves added up over all seeds. */
  progress: SearchProgress | null
  running: boolean
  done: boolean
  error: string | null
  /** Every seed's run, for "best of n" and how close the others came. */
  seeds: SeedRun[]
  /**
   * The input changed after the search started (prices, cards, which divisions are home). The
   * search keeps working on the snapshot it was given and nothing restarts by itself; the page
   * offers to search again.
   */
  stale: boolean
}

/** Seeds run side by side: one per spare core, at least two, at most four. */
export function seedCount(): number {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4
  return Math.max(2, Math.min(4, cores - 1))
}

const byScore = (r: SearchResult | null) => (r ? (r.score ?? r.perHour) : -Infinity)
const byBalanced = (r: SearchResult | null) => (r?.balanced ? (r.balanced.score ?? r.balanced.perHour) : -Infinity)

/** The best main answer of all seeds, carrying the best balanced answer of all seeds. */
function combine(seeds: SeedRun[]): SearchResult | null {
  const done = seeds.filter((s) => s.result)
  if (!done.length) return null
  const best = done.reduce((a, b) => (byScore(b.result) > byScore(a.result) ? b : a)).result!
  const balanced = done.reduce((a, b) => (byBalanced(b.result) > byBalanced(a.result) ? b : a)).result?.balanced
  // "What was tried" from every seed: the most divisions each managed of each mission, and the best value.
  const tried = new Map<number, NonNullable<SearchResult['tried']>[number]>()
  for (const s of done)
    for (const t of s.result!.tried ?? []) {
      const was = tried.get(t.mission.id)
      if (!was) tried.set(t.mission.id, { ...t })
      else {
        was.count = Math.max(was.count, t.count)
        was.perHour = Math.max(was.perHour, t.perHour)
      }
    }
  return {
    ...best,
    balanced: balanced ?? best.balanced,
    moves: done.reduce((n, s) => n + s.result!.moves, 0),
    tried: [...tried.values()].sort((a, b) => b.perHour - a.perHour || b.count - a.count)
  }
}

const ORDER: SearchProgress['phase'][] = ['starting', 'coverage', 'greedy', 'annealing', 'polishing', 'balancing', 'checking']

/** The slowest seed's phase and clock, with the moves of all of them. */
function slowest(seeds: SeedRun[]): SearchProgress | null {
  const running = seeds.filter((s) => !s.done && s.progress)
  if (!running.length) return null
  const behind = running.reduce((a, b) => (ORDER.indexOf(b.progress!.phase) < ORDER.indexOf(a.progress!.phase) ? b : a))
  return {
    ...behind.progress!,
    best: Math.max(...seeds.map((s) => s.progress?.best ?? -Infinity)),
    moves: seeds.reduce((n, s) => n + (s.progress?.moves ?? s.result?.moves ?? 0), 0)
  }
}

/**
 * Runs the army search in Web Workers: the same frozen input, one seed per worker, side by side;
 * the best answer wins. It starts only when `start` is called and never restarts by itself: when
 * the input changes afterwards, `stale` says so and the answer stays as it is. `stop` ends every
 * seed, keeping the best army found so far.
 */
export function useArmySearch(input: SearchInput | null) {
  const empty: ArmySearchState = { result: null, progress: null, running: false, done: false, error: null, seeds: [], stale: false }
  const [state, setState] = useState<ArmySearchState>(empty)
  const workers = useRef<Worker[]>([])
  const seq = useRef(0)

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
        input.effort
      ])
    : ''
  /** The key of the input the current answer was searched with. */
  const searchedKey = useRef<string | null>(null)

  const terminate = () => {
    for (const w of workers.current) w.terminate()
    workers.current = []
  }

  const stop = useCallback(() => {
    terminate()
    setState((s) => ({ ...s, running: false, progress: null, done: !!s.result }))
  }, [])

  const start = useCallback(() => {
    const current = latest.current
    if (!current) return
    terminate()
    const id = ++seq.current
    searchedKey.current = keyRef.current
    const n = seedCount()
    const seeds: SeedRun[] = Array.from({ length: n }, (_, i) => ({ seed: i + 1, result: null, progress: null, done: false }))
    setState({
      result: null,
      progress: { phase: 'starting', pct: 0, ms: 0, phaseMs: Infinity, best: 0, moves: 0 },
      running: true,
      done: false,
      error: null,
      seeds,
      stale: false
    })
    // The snapshot every seed works on: a structured copy goes to each worker, so nothing the page
    // reads later reaches a running search.
    seeds.forEach((sd, i) => {
      const w = new Worker(new URL('./armySearch.worker.ts', import.meta.url), { type: 'module' })
      workers.current.push(w)
      const update = (patch: Partial<SeedRun>) =>
        setState((s) => {
          if (seq.current !== id) return s
          const next = s.seeds.map((x, j) => (j === i ? { ...x, ...patch } : x))
          const allDone = next.every((x) => x.done)
          return {
            ...s,
            seeds: next,
            result: combine(next) ?? s.result,
            progress: allDone ? null : slowest(next),
            running: !allDone,
            done: allDone
          }
        })
      w.onmessage = (e: MessageEvent<SearchReply>) => {
        const r = e.data
        if (r.id !== id) return
        if (r.type === 'progress') update({ progress: r.progress })
        else if (r.type === 'best') update({ result: r.result })
        else if (r.type === 'done') {
          update({ result: r.result, done: true, progress: null })
          w.terminate()
        } else if (r.type === 'error') {
          setState((s) => ({ ...s, error: r.message }))
          update({ done: true })
          w.terminate()
        }
      }
      w.onerror = (e) => {
        setState((s) => ({ ...s, error: e.message || 'The search stopped unexpectedly' }))
        update({ done: true })
      }
      const request: SearchRequest = { id, input: { ...current, seed: sd.seed } }
      w.postMessage(request)
    })
    // Development: the last input, for balanceDiagnostics from the console.
    if (import.meta.env.DEV) (window as unknown as { __pdSearchInput?: SearchInput }).__pdSearchInput = current
  }, [])

  // The key, readable inside start without making start change.
  const keyRef = useRef(key)
  keyRef.current = key

  // A changed input does not restart anything: an answer (or a running search) says it is out of date.
  useEffect(() => {
    if (searchedKey.current === null) return
    setState((s) => (s.stale === (key !== searchedKey.current) ? s : { ...s, stale: key !== searchedKey.current }))
  }, [key])

  useEffect(() => () => terminate(), [])

  return { ...state, start, stop }
}
