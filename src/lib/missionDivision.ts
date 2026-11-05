import type { AssetRef } from '@/data/assets'

import type { Division } from '@/data/game'

import { evaluate, solveBundle, type Bundle, type Candidate, type SlotKind, type WarlordOption } from './bundle'
import { GEAR_KINDS, kindOf, type Kind } from './stats'

/*
 * The division for one mission, built only from the reserve (staked NFTs in no division).
 *
 * Rewards are flat per division, so any division that meets the requirement earns the same. The
 * best one therefore uses up as little of the reserve as it can: the weakest units that still reach
 * the target, so the strong ones stay free for harder missions, and a low move cost, since every
 * move point adds 10 s to the mission lock. The bundle solver does the search; instead of WAX, each
 * NFT "costs" the strength it ties up. Nothing is bought: no Forge slots, no Forge levels.
 */

/** One move point costs as much as this many stat points (it lengthens every mission cycle). */
export const MOVE_WEIGHT = 3
/** Weighted like this, move matters more than strength: the fastest division that meets the mission. */
export const FAST_MOVE_WEIGHT = 30
/** A bigger warlord is kept for bigger missions, when a smaller one fits. */
const WARLORD_SLOT_WEIGHT = 2

export interface MissionPlan {
  bundle: Bundle
  /** Candidate key → the staked NFT. */
  assets: Map<string, AssetRef>
}

export function planMissionDivision(
  free: Record<Kind, AssetRef[]>,
  target: { atk: number; def: number },
  forgeLevel: number,
  /** Forge slots still free per gear kind (creatures need none). */
  slotsFree: Record<SlotKind, number>,
  /** mercPenalty: extra cost per mercenary, so that fewer, stronger units (and gear) are preferred. */
  /**
   * mercPenalty: extra cost per mercenary, so that fewer, stronger units (and gear) are preferred.
   * costOf: the caller's own cost for a unit (given the usual one), e.g. what it would earn elsewhere.
   * maxMove: the division's move cost may not exceed this (null when no division fits under it).
   */
  options: {
    moveWeight?: number
    gridMax?: number
    mercPenalty?: number
    costOf?: (a: AssetRef, usual: number) => number
    maxMove?: number
  } = {}
): MissionPlan | null {
  const moveWeight = options.moveWeight ?? MOVE_WEIGHT
  const mercPenalty = options.mercPenalty ?? 0
  const assets = new Map<string, AssetRef>()
  const warlords: WarlordOption[] = []
  const items: Candidate[] = []

  for (const list of Object.values(free))
    for (const a of list) {
      const st = a.stats
      const kind = kindOf(st)
      if (!st || !kind) continue
      const minLevel = Number(st.min_forge_level || 0)
      // Only what works at today's Forge level: nothing gets upgraded here.
      if (minLevel > forgeLevel) continue
      const key = a.assetId
      if (kind === 'warlord') {
        if (st.slots_max > 0) {
          assets.set(key, a)
          const moveReduction = Number(st.movecost_reduction || 0)
          warlords.push({
            key,
            slots: Number(st.slots_max),
            minLevel,
            moveReduction,
            // A warlord that takes move off the division is worth that much less: it saves the move elsewhere.
            cost: Math.max(0.1, Number(st.slots_max) * WARLORD_SLOT_WEIGHT - moveWeight * moveReduction)
          })
        }
        continue
      }
      const atk = Number(st.attack || 0)
      const def = Number(st.defense || 0)
      const move = Number(st.movecost || 0)
      const moveReduction = Number(st.movecost_reduction || 0)
      const lava =
        kind === 'lavalux'
          ? {
              atkMult: Number(st.attack_mult_bp || 10000) / 10000,
              defMult: Number(st.defense_mult_bp || 10000) / 10000,
              moveMult: Number(st.movecost_mult_bp || 10000) / 10000
            }
          : null
      const usual = lava
        ? // A Lava Lux costs the move it adds and is worth its multiplier: a shined one (more of
          // both multipliers, less move) is always the cheaper pick, never saved for later.
          Math.max(0.1, 40 + (lava.moveMult - 1) * 20 * moveWeight - (lava.atkMult - 1 + lava.defMult - 1) * 40)
        : Math.max(0.1, atk + def + moveWeight * (move - moveReduction) + (kind === 'mercenary' ? mercPenalty : 0))
      const cost = options.costOf ? Math.max(0.1, options.costOf(a, usual)) : usual
      assets.set(key, a)
      items.push({
        key,
        kind: kind as Candidate['kind'],
        group: a.templateId,
        atk,
        def,
        move,
        moveReduction,
        ...(lava ?? {}),
        minLevel,
        cost
      })
    }

  if (!warlords.length || !items.some((i) => i.kind === 'mercenary')) return null
  const levels = [0, 0, 0, 0, 0, 0].map((_, L) => (L === forgeLevel ? 0 : Infinity))
  const bundle = solveBundle({
    atk: target.atk,
    def: target.def,
    ...(options.gridMax ? { gridMax: options.gridMax } : {}),
    ...(options.maxMove ? { maxMove: options.maxMove } : {}),
    warlords,
    items,
    economy: {
      forgeLevel,
      levelWax: levels,
      levelTlm: levels,
      slots: {
        weapon: { free: Math.max(0, slotsFree.weapon), offers: [] },
        supply: { free: Math.max(0, slotsFree.supply), offers: [] },
        lavalux: { free: Math.max(0, slotsFree.lavalux), offers: [] }
      }
    }
  })
  return bundle ? { bundle, assets } : null
}

/** A staked NFT as a solver candidate (cost 0: nothing is bought), or null when it has no stats. */
export function candidateOf(a: AssetRef): Candidate | null {
  const st = a.stats
  const kind = kindOf(st)
  if (!st || !kind || kind === 'warlord') return null
  const lava = kind === 'lavalux'
  return {
    key: a.assetId,
    kind,
    group: a.templateId,
    atk: Number(st.attack || 0),
    def: Number(st.defense || 0),
    move: Number(st.movecost || 0),
    moveReduction: Number(st.movecost_reduction || 0),
    ...(lava
      ? {
          atkMult: Number(st.attack_mult_bp || 10000) / 10000,
          defMult: Number(st.defense_mult_bp || 10000) / 10000,
          moveMult: Number(st.movecost_mult_bp || 10000) / 10000
        }
      : {}),
    minLevel: Number(st.min_forge_level || 0),
    cost: 0
  }
}

/**
 * A division exactly as it stands now, as a plan: so the army search can keep it as it is instead
 * of taking it apart. Null when it has no warlord or no mercenaries.
 */
export function planFromDivision(d: Division): MissionPlan | null {
  if (!d.leader || !d.units.length) return null
  const assets = new Map<string, AssetRef>()
  assets.set(d.leader.assetId, d.leader)
  const mercs: Candidate[] = []
  const gear: Bundle['gear'] = { weapon: [], supply: [], creature: [], lavalux: [] }
  for (const u of d.units) {
    const merc = candidateOf(u.asset)
    if (!merc) return null
    assets.set(u.asset.assetId, u.asset)
    mercs.push(merc)
    for (const k of GEAR_KINDS) {
      const g = u.gear[k]
      if (!g) continue
      const c = candidateOf(g)
      if (!c) return null
      assets.set(g.assetId, g)
      gear[k].push(c)
    }
  }
  const warlord: WarlordOption = {
    key: d.leader.assetId,
    slots: d.slotsMax,
    minLevel: Number(d.leader.stats?.min_forge_level || 0),
    cost: 0,
    moveReduction: Number(d.leader.stats?.movecost_reduction || 0)
  }
  const ev = evaluate({ warlord, mercs, gear })
  const bundle: Bundle = {
    warlord,
    mercs,
    gear,
    ...ev,
    cost: 0,
    nftCost: 0,
    slotCost: 0,
    forgeCost: 0,
    level: 0,
    slotsBought: { weapon: [], supply: [], lavalux: [] }
  }
  return { bundle, assets }
}

/** At most this many of the reserve's own attack shares are tried on top of the fixed splits. */
const MAX_RESERVE_RATIOS = 12

/**
 * The attack shares (attack / (attack + defense)) the reserve's mercenaries have, the most common
 * first: a division of lopsided units only meets a split close to their own share.
 */
function reserveRatios(free: Record<Kind, AssetRef[]>): number[] {
  const counts = new Map<number, { ratio: number; n: number }>()
  for (const a of free.mercenary) {
    const atk = Number(a.stats?.attack || 0)
    const def = Number(a.stats?.defense || 0)
    if (atk + def <= 0) continue
    const ratio = atk / (atk + def)
    const bucket = Math.round(ratio * 100)
    if (SCORE_SPLITS.some((f) => Math.round(f * 100) === bucket)) continue
    const c = counts.get(bucket)
    if (c) c.n++
    else counts.set(bucket, { ratio, n: 1 })
  }
  return [...counts.values()]
    .sort((x, y) => y.n - x.n)
    .slice(0, MAX_RESERVE_RATIOS)
    .map((c) => c.ratio)
}

/** How a score target is split between attack and defense when looking for the cheapest division. */
const SCORE_SPLITS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9, 0, 1]

/** Grid of the quick first pass over every split; the best few are then solved on the full grid. */
const SCAN_GRID = 16
const REFINE_SPLITS = 3
/** A full solve slower than this (big reserves) ends the refining after the best split. */
const SLOW_SOLVE_MS = 1000

const better = (b: MissionPlan, best: MissionPlan | null) =>
  !best ||
  b.bundle.cost < best.bundle.cost - 1e-9 ||
  (Math.abs(b.bundle.cost - best.bundle.cost) <= 1e-9 && b.bundle.move < best.bundle.move)

/**
 * The search behind planScoreDivision, one solver run per step so a caller can pause between them.
 * The solver works on separate attack and defense minimums, so the score is tried at several
 * splits on a coarse grid, and the most promising splits are solved again on the full grid.
 */
export function* scoreSearch(
  free: Record<Kind, AssetRef[]>,
  score: number,
  forgeLevel: number,
  slotsFree: Record<SlotKind, number>,
  options: Parameters<typeof planMissionDivision>[4] = {}
): Generator<void, MissionPlan | null> {
  if (!(score > 0)) return null
  const splits: { atk: number; def: number; cost: number }[] = []
  const tried = new Set<string>()
  for (const f of [...SCORE_SPLITS, ...reserveRatios(free)]) {
    const atk = Math.floor(score * f)
    const def = Math.max(0, Math.ceil(score - atk))
    const key = `${atk}/${def}`
    if (tried.has(key)) continue
    tried.add(key)
    const plan = planMissionDivision(free, { atk, def }, forgeLevel, slotsFree, { ...options, gridMax: SCAN_GRID })
    if (plan && plan.bundle.atk + plan.bundle.def >= score) splits.push({ atk, def, cost: plan.bundle.cost })
    yield
  }
  let best: MissionPlan | null = null
  for (const sp of splits.sort((x, y) => x.cost - y.cost).slice(0, REFINE_SPLITS)) {
    const started = Date.now()
    const plan = planMissionDivision(free, { atk: sp.atk, def: sp.def }, forgeLevel, slotsFree, options)
    if (plan && plan.bundle.atk + plan.bundle.def >= score && better(plan, best)) best = plan
    // On a very big reserve a full solve takes seconds: the coarse pass's favourite split is enough.
    if (best && Date.now() - started > SLOW_SOLVE_MS) break
    yield
  }
  return best
}

/** The weakest division (lowest cost, then lowest move) whose attack plus defense reaches `score`. */
export function planScoreDivision(
  free: Record<Kind, AssetRef[]>,
  score: number,
  forgeLevel: number,
  slotsFree: Record<SlotKind, number>,
  options: Parameters<typeof planMissionDivision>[4] = {}
): MissionPlan | null {
  const run = scoreSearch(free, score, forgeLevel, slotsFree, options)
  for (;;) {
    const step = run.next()
    if (step.done) return step.value
  }
}

/** planScoreDivision without blocking the page: a pause after every solver run; stops when cancelled. */
export async function planScoreDivisionAsync(
  free: Record<Kind, AssetRef[]>,
  score: number,
  forgeLevel: number,
  slotsFree: Record<SlotKind, number>,
  cancelled: () => boolean
): Promise<MissionPlan | null | undefined> {
  const run = scoreSearch(free, score, forgeLevel, slotsFree)
  for (;;) {
    if (cancelled()) return undefined
    const step = run.next()
    if (step.done) return step.value
    await new Promise((r) => setTimeout(r, 0))
  }
}
