import {
  fitMoveLimit,
  gridCounts,
  gridStep,
  levelUnlocks,
  reprice,
  shadeForMove,
  valid,
  withinMove,
  type Bundle,
  type SolveInput
} from './bundle'
import type { SolverPool } from './solverPool'

/*
 * solveBundle, spread over a worker pool. The same search, split where it is independent:
 *
 *  - every Forge level is solved at the same time instead of one after another;
 *  - within a level, the expensive part is trying each mercenary count (1 … warlord slots), and
 *    each count is independent, so the counts are split across workers in runs of neighbouring
 *    counts, sized so each run is about the same work (trying k costs about k).
 *
 * Pieces are handed out lowest level first and each reads the best answer confirmed so far when it
 * starts, so the dearer levels are mostly skipped, as the sequential search skips them.
 *
 * The answers match solveBundle's.
 */

/** Move prices that worked, per target: later correction rounds start from them (one or two solves). */
const moveHints = new Map<string, number>()
const MOVE_SEARCH_STEPS = 6

/**
 * The cheapest bundle within the move limit; see searchMoveLimit in bundle.ts, which this mirrors
 * with the parallel solver.
 */
export async function solveBundleParallel(input: SolveInput, pool: SolverPool): Promise<Bundle | null> {
  const base = await solveUnlimitedParallel(input, pool)
  if (!input.maxMove || !base || withinMove(base, input)) return base
  const hintKey = `${input.atk}/${input.def}/${input.maxMove}`
  const hint = moveHints.get(hintKey)
  // The unlimited answer, repaired, is the first candidate.
  let best: Bundle | null = fitMoveLimit(base, input)
  let lo = 0
  let hi = Infinity
  let lambda = hint && hint > 0 ? hint : Math.max(0.01, base.cost / Math.max(1, base.move))
  for (let step = 0; step < MOVE_SEARCH_STEPS; step++) {
    const got = await solveUnlimitedParallel(shadeForMove(input, lambda), pool)
    const priced = got && reprice(got, input)
    if (priced && valid(priced, input) && withinMove(priced, input)) hi = lambda
    else lo = lambda
    // Fitted and polished at real prices, whether this price of move was enough or not.
    const b = priced && valid(priced, input) ? fitMoveLimit(priced, input) : null
    if (b && (!best || b.cost < best.cost)) best = { ...b, moveLambda: lambda }
    if (hi !== Infinity && hi - lo < hi * 0.1) break
    lambda = hi === Infinity ? lambda * 3 : (lo + hi) / 2
  }
  if (best?.moveLambda) moveHints.set(hintKey, best.moveLambda)
  return best
}

async function solveUnlimitedParallel(input: SolveInput, pool: SolverPool): Promise<Bundle | null> {
  if (input.atk <= 0 && input.def <= 0) return null
  if (!input.warlords.length) return null
  const eco = input.economy
  const levels: number[] = []
  for (let L = eco.forgeLevel; L <= 5; L++) {
    const levelWax = eco.levelWax[L]
    if (levelWax === undefined || !Number.isFinite(levelWax)) continue
    if (L > eco.forgeLevel && !levelUnlocks(input, L)) continue
    levels.push(L)
  }
  if (!levels.length) return null
  // One piece per level: a level's scan prunes its own counts with a bound it computes once, so
  // splitting the counts across workers would redo that work in every piece.
  const perLevel = 1
  // The cheapest bundle confirmed so far (built and valid). Pieces started later prune against it:
  // a level whose upgrade alone costs more, or counts that cannot beat it, finish at once.
  let bestCost = Infinity

  async function atLevel(L: number): Promise<Bundle | null> {
    let ta = input.atk
    let td = input.def
    // Raise the internal target a grid step at a time when rounding left the answer short.
    for (let attempt = 0; attempt < 12; attempt++) {
      const K = gridCounts(input, L)
      if (K <= 0) return null
      const parts = Math.min(perLevel, K)
      const subsets = chunkCounts(K, parts)
      const scans = await Promise.all(
        subsets.map((counts) =>
          pool.run<{ k: number; total: number } | null>(() =>
            eco.levelWax[L] >= bestCost ? null : { type: 'scan', input, ta, td, L, counts, bound: bestCost }
          )
        )
      )
      const found = scans.filter((s): s is { k: number; total: number } => !!s).sort((a, b) => a.total - b.total || a.k - b.k)[0]
      if (!found) return null
      // Building the winner jumps the queue: its cost is the bound every later piece prunes against.
      const b = await pool.run<Bundle | null>({ type: 'build', input, ta, td, L, k: found.k }, true)
      if (!b) return null
      if (valid(b, input)) {
        bestCost = Math.min(bestCost, b.cost)
        return b
      }
      if (b.atk < input.atk) ta += input.atk - b.atk + gridStep(input, ta)
      if (b.def < input.def) td += input.def - b.def + gridStep(input, td)
    }
    return null
  }

  const results = await Promise.all(levels.map(atLevel))
  let best: Bundle | null = null
  for (const b of results) if (b && (!best || b.cost < best.cost)) best = b
  return best ? pool.run<Bundle>({ type: 'polish', input, bundle: best }) : null
}

/** Splits counts 1…K into `parts` runs of neighbouring counts with about equal work (count k costs ~k). */
function chunkCounts(K: number, parts: number): number[][] {
  const total = (K * (K + 1)) / 2
  const out: number[][] = []
  let cur: number[] = []
  let work = 0
  for (let k = 1; k <= K; k++) {
    cur.push(k)
    work += k
    if (work >= (total * (out.length + 1)) / parts && out.length < parts - 1) {
      out.push(cur)
      cur = []
    }
  }
  if (cur.length) out.push(cur)
  return out
}
