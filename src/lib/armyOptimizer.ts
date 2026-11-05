import type { AssetRef } from '@/data/assets'
import type { Division } from '@/data/game'

import { evaluate, type Bundle, type Candidate, type SlotKind, type WarlordOption } from './bundle'
import { isTokenLoop, meetsRequirements, tlmPerHour, type MissionEconomics } from './loop'
import type { Market } from './market'
import {
  candidateOf,
  FAST_MOVE_WEIGHT,
  MOVE_WEIGHT,
  planFromDivision,
  planMissionDivision,
  type MissionPlan
} from './missionDivision'
import { GEAR_KINDS, type GearKind, type Kind } from './stats'

/*
 * The army that earns the most TLM per hour from the missions on offer, built only from what is
 * staked. Rewards are flat per division and per cycle, so the earning of a division on a mission
 * is the mission's net reward over its cycle, and the cycle is shorter the lower the division's
 * move cost. More divisions earn more, up to the player's allowance and the warlords available.
 *
 * Choosing which missions to field, and with which NFTs, is a packing problem. It is searched
 * division by division: field a division for a mission, take its NFTs out of the pool, repeat.
 * Taking the best-paying next division every time can starve a later one (two 200-ATK divisions
 * may leave nothing for a third, where one 200 and two 100s would earn more), so a beam search
 * keeps the few best partial armies at every step instead of one. Two cheaper greedy passes with
 * other rankings (most per mercenary used; most per stat point used) run as well, and the army
 * that earns the most wins. Each division is the smallest that meets its mission (see
 * planMissionDivision), so the strong units stay for the missions that need them. The divisions
 * that exist now are candidates too, kept as they are, so the answer is never worse than leaving
 * the army alone.
 */

export interface OptimizedDivision {
  mission: MissionEconomics
  plan: MissionPlan
  perHour: number
  /** Set when this is one of the existing divisions, kept exactly as it is. */
  existingId?: number
}

export interface ArmyPlan {
  divisions: OptimizedDivision[]
  /** TLM per hour of the new divisions together. */
  perHour: number
  strategy: Strategy
}

export type Strategy = 'per-hour' | 'per-mercenary' | 'per-stat'
export const STRATEGIES: Strategy[] = ['per-hour', 'per-mercenary', 'per-stat']
/** Partial armies kept per step in the beam search (the 'per-hour' pass): wide while that is cheap. */
const beamWidth = (input: OptimizeInput) => {
  const n = input.pool.mercenary.length
  return n <= 60 ? 12 : n <= 120 ? 6 : 3
}
/** Past this much planning time the beam narrows to one, so a huge army still finishes. */
const BEAM_BUDGET_MS = 10_000
/** Hard stop: past this the search keeps what it has (a huge army may get fewer divisions than it could). */
const TOTAL_BUDGET_MS = 40_000
/** Extra passes only run while this much of the budget is left. */
const EXTRA_PASS_MIN_MS = 15_000
/**
 * Grid steps for the division planner. A 5 000 ATK target is then met to within about 6 points
 * (the planner adds a unit when rounding leaves it short), and each solve is several times faster.
 */
const PLANNER_GRID = 800
/**
 * Each mission is planned four ways: the division that uses the least strength (move counts a
 * little), the fastest one that meets it (move counts a lot), the one with the fewest mercenaries,
 * and the one made of the units worth the least elsewhere (see opportunityCost). The search keeps
 * whichever leads to the better army.
 */
type Variant = { moveWeight: number; mercPenalty?: number; costOf?: (a: AssetRef, usual: number) => number }
const VARIANTS: Variant[] = [
  { moveWeight: MOVE_WEIGHT },
  { moveWeight: FAST_MOVE_WEIGHT },
  // Fewest mercenaries: strong units and gear, which keeps warlord slots and troops for other divisions.
  { moveWeight: MOVE_WEIGHT, mercPenalty: 1000 }
]
/** One hour of what a unit could earn elsewhere counts as this many strength points. */
const OPPORTUNITY_WEIGHT = 100

/**
 * The fourth way to plan a division: every unit costs what it could earn on its own (a mercenary
 * alone on the best mission it reaches; a weapon by how much it lifts the best single mercenary),
 * so the division is filled with the units that are worth the least anywhere else. The strength
 * cost stays as a tie-break.
 */
function opportunityCost(input: OptimizeInput, missions: MissionEconomics[]): Variant['costOf'] {
  const rate = (atk: number, def: number, move: number) => {
    let r = 0
    for (const m of missions) {
      if (!meetsRequirements(m, atk, def)) continue
      const v = tlmPerHour(m, move, input.market)
      if (v > r) r = v
    }
    return r
  }
  const stat = (a: AssetRef) => ({
    atk: Number(a.stats?.attack ?? 0),
    def: Number(a.stats?.defense ?? 0),
    move: Number(a.stats?.movecost ?? 0)
  })
  const alone = new Map(input.pool.mercenary.map((m) => [m.assetId, rate(stat(m).atk, stat(m).def, stat(m).move)]))
  const value = new Map<string, number>(alone)
  for (const w of input.pool.weapon) {
    const ws = stat(w)
    let gain = 0
    for (const m of input.pool.mercenary) {
      const ms = stat(m)
      gain = Math.max(gain, rate(ms.atk + ws.atk, ms.def + ws.def, ms.move) - (alone.get(m.assetId) ?? 0))
    }
    value.set(w.assetId, gain)
  }
  return (a, usual) => (value.has(a.assetId) ? OPPORTUNITY_WEIGHT * value.get(a.assetId)! + usual / 100 : usual)
}

export interface OptimizeInput {
  /** Everything that may be rearranged: the reserve plus the NFTs of the divisions to be disbanded. */
  pool: Record<Kind, AssetRef[]>
  missions: MissionEconomics[]
  market: Market
  forgeLevel: number
  /** Forge slots per gear kind not used by the divisions that stay. */
  slotsFree: Record<SlotKind, number>
  /** New divisions allowed: the allowance minus the divisions that stay. */
  maxDivisions: number
  /** The divisions whose NFTs are in the pool, as they stand: the search may keep any of them as it is. */
  existing?: Division[]
  /**
   * Divisions on missions of the same length are claimed and sent out again together, so they all
   * run at the pace of the slowest of them: the army is valued that way during the search, and the
   * new divisions of each length then trade units until their move costs are close (balanceMoves).
   */
  alignMove?: boolean
  /**
   * Divisions that stay as they are (out on a mission), by the length of the mission they run and
   * their move cost: with alignMove, the new divisions of that length are drawn towards them and
   * valued at the pace of the slowest of all.
   */
  anchors?: { cooldownBase: number; move: number }[]
}

export type Progress = { strategy: Strategy; strategyIndex: number; division: number }

interface Node {
  pool: Record<Kind, AssetRef[]>
  slots: Record<SlotKind, number>
  divisions: OptimizedDivision[]
  total: number
  /** total plus what the rest of the pool could still earn: what the beam ranks by. */
  rank: number
}

/**
 * An optimistic guess at what a pool can still earn: for every division still allowed, the best
 * rate one remaining mercenary could earn alone (with a remaining weapon, while weapon slots
 * last), each mercenary and weapon counted once. It is the same guess for every branch at the same
 * depth except through what the branch has used up, which is exactly what the ranking needs to
 * see: a division that eats the strong single units or the weapons leaves less for the rest.
 */
function potential(node: Node, input: OptimizeInput, missions: MissionEconomics[]): number {
  const left = Math.min(input.maxDivisions - node.divisions.length, node.pool.warlord.length, node.pool.mercenary.length)
  if (left <= 0) return 0
  const weapons = node.pool.weapon
    .map((w) => ({ atk: Number(w.stats?.attack ?? 0), def: Number(w.stats?.defense ?? 0) }))
    .sort((x, y) => y.atk + y.def - (x.atk + x.def))
  const weaponSlots = Math.min(node.slots.weapon, weapons.length)
  const best = weapons[0] ?? { atk: 0, def: 0 }
  const rate = (atk: number, def: number, move: number) => {
    let r = 0
    for (const mission of missions) {
      if (!meetsRequirements(mission, atk, def)) continue
      const v = tlmPerHour(mission, move, input.market)
      if (v > r) r = v
    }
    return r
  }
  const singles = node.pool.mercenary.map((m) => {
    const atk = Number(m.stats?.attack ?? 0)
    const def = Number(m.stats?.defense ?? 0)
    const move = Number(m.stats?.movecost ?? 0)
    const alone = rate(atk, def, move)
    return { alone, armed: weaponSlots > 0 ? Math.max(alone, rate(atk + best.atk, def + best.def, move)) : alone }
  })
  // The best few mercenaries, one per open division; the weapon goes to those it helps most, at most once per slot.
  singles.sort((x, y) => y.armed - x.armed)
  const chosen = singles.slice(0, left)
  const gains = chosen.map((c) => c.armed - c.alone).sort((x, y) => y - x)
  const armedGain = gains.slice(0, weaponSlots).reduce((n, g) => n + g, 0)
  return chosen.reduce((n, c) => n + c.alone, 0) + armedGain
}

/** The best token loop a division of these stats can run, or null when no mission pays. */
export function bestLoop(
  d: { atk: number; def: number; move: number },
  missions: MissionEconomics[],
  market: Market
): { mission: MissionEconomics; perHour: number } | null {
  let best: { mission: MissionEconomics; perHour: number } | null = null
  for (const m of missions) {
    if (m.state !== 'active' || !isTokenLoop(m) || !meetsRequirements(m, d.atk, d.def)) continue
    const perHour = tlmPerHour(m, d.move, market)
    if (perHour > 0 && (!best || perHour > best.perHour)) best = { mission: m, perHour }
  }
  return best
}

/** The staked NFTs of some divisions and the reserve, as one pool by kind. */
export function poolOf(free: Record<Kind, AssetRef[]>, divisions: Division[]): Record<Kind, AssetRef[]> {
  const pool: Record<Kind, AssetRef[]> = {
    warlord: [...free.warlord],
    mercenary: [...free.mercenary],
    weapon: [...free.weapon],
    supply: [...free.supply],
    creature: [...free.creature],
    lavalux: [...free.lavalux]
  }
  for (const d of divisions) {
    if (d.leader) pool.warlord.push(d.leader)
    for (const u of d.units) {
      pool.mercenary.push(u.asset)
      for (const k of GEAR_KINDS) if (u.gear[k]) pool[k].push(u.gear[k]!)
    }
  }
  return pool
}

/** Missions worth fielding: active token loops, one per distinct requirement-and-pay. */
export function candidateMissions(missions: MissionEconomics[]): MissionEconomics[] {
  const seen = new Set<string>()
  return missions.filter((m) => {
    if (m.state !== 'active' || !isTokenLoop(m)) return false
    const key = [m.minAtk, m.minDef, m.cooldownBase, m.rewardTlm, m.rewardDef, m.costTlm, m.costDef].join('/')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const without = (pool: Record<Kind, AssetRef[]>, used: Set<string>): Record<Kind, AssetRef[]> => ({
  warlord: pool.warlord.filter((a) => !used.has(a.assetId)),
  mercenary: pool.mercenary.filter((a) => !used.has(a.assetId)),
  weapon: pool.weapon.filter((a) => !used.has(a.assetId)),
  supply: pool.supply.filter((a) => !used.has(a.assetId)),
  creature: pool.creature.filter((a) => !used.has(a.assetId)),
  lavalux: pool.lavalux.filter((a) => !used.has(a.assetId))
})

const usedKeys = (p: MissionPlan) => {
  const b = p.bundle
  return new Set([b.warlord.key, ...b.mercs.map((m) => m.key), ...GEAR_KINDS.flatMap((k) => b.gear[k].map((g) => g.key))])
}

/** How a strategy ranks a candidate division. Higher is better. */
function score(strategy: Strategy, perHour: number, p: MissionPlan): number {
  const b = p.bundle
  switch (strategy) {
    case 'per-hour':
      return perHour
    case 'per-mercenary':
      return perHour / Math.max(1, b.mercs.length)
    case 'per-stat':
      return perHour / Math.max(1, b.atk + b.def)
  }
}

/** The signature of a partial army: which NFTs it uses on which missions, whatever the order. */
const signature = (n: Node) =>
  n.divisions
    .map((d) => d.mission.id + ':' + [...usedKeys(d.plan)].sort().join(','))
    .sort()
    .join('|')

/**
 * Beam search over the next division to field. Width 1 is plain greedy. Partial armies are ranked
 * by `score` summed over their divisions; the answer is the army with the most TLM per hour.
 */
function search(
  input: OptimizeInput,
  strategy: Strategy,
  width: number,
  deadline: number,
  onProgress?: (p: Progress) => void
): ArmyPlan {
  const missions = candidateMissions(input.missions)
  // Missions in order of what they could pay at best (no move at all). With one partial army and
  // the per-hour ranking that lets a step stop early; it is a sensible order for the rest too.
  const ceiling = new Map(missions.map((m) => [m.id, tlmPerHour(m, 0, input.market)]))
  const ordered = [...missions].filter((m) => ceiling.get(m.id)! > 0).sort((a, b) => ceiling.get(b.id)! - ceiling.get(a.id)!)
  const started = Date.now()
  let outOfTime = false
  const variants: Variant[] = [...VARIANTS, { moveWeight: MOVE_WEIGHT, costOf: opportunityCost(input, ordered) }]
  const start: Node = { pool: input.pool, slots: { ...input.slotsFree }, divisions: [], total: 0, rank: 0 }
  // What a pool could reach at most: the strongest units up to the biggest warlord, plus all gear.
  const reach = (pool: Record<Kind, AssetRef[]>, stat: 'attack' | 'defense') => {
    const slots = Math.max(0, ...pool.warlord.map((w) => w.stats?.slots_max ?? 0))
    const mercs = pool.mercenary
      .map((a) => Number(a.stats?.[stat] ?? 0))
      .sort((a, b) => b - a)
      .slice(0, slots)
    const gear = (['weapon', 'supply', 'creature'] as Kind[]).flatMap((k) =>
      pool[k]
        .map((a) => Number(a.stats?.[stat] ?? 0))
        .sort((a, b) => b - a)
        .slice(0, slots)
    )
    return [...mercs, ...gear].reduce((n, v) => n + v, 0) * 1.7
  }
  // The divisions that exist now, as candidates to keep as they are.
  const keepable = (input.existing ?? [])
    .map((d) => ({ d, plan: planFromDivision(d), loop: bestLoop(d, input.missions, input.market) }))
    .filter(
      (x): x is { d: Division; plan: MissionPlan; loop: { mission: MissionEconomics; perHour: number } } => !!x.plan && !!x.loop
    )
  let frontier: Node[] = [start]
  let best: Node = start
  for (let step = 1; step <= input.maxDivisions && frontier.length; step++) {
    onProgress?.({ strategy, strategyIndex: STRATEGIES.indexOf(strategy), division: step })
    const children: Node[] = []
    const seen = new Set<string>()
    for (const node of frontier) {
      if (!node.pool.warlord.length || !node.pool.mercenary.length) continue
      let bestHere = -Infinity
      // Keeping an existing division as it is, when every NFT of it is still in the pool.
      const inPool = new Set(
        [...node.pool.warlord, ...node.pool.mercenary, ...GEAR_KINDS.flatMap((k) => node.pool[k])].map((a) => a.assetId)
      )
      for (const { d, plan, loop } of keepable) {
        const keys = usedKeys(plan)
        if ([...keys].some((k) => !inPool.has(k))) continue
        const b = plan.bundle
        if ((['weapon', 'supply', 'lavalux'] as SlotKind[]).some((k) => b.gear[k].length > node.slots[k])) continue
        const s = score(strategy, loop.perHour, plan)
        bestHere = Math.max(bestHere, s)
        const slots = { ...node.slots }
        for (const k of ['weapon', 'supply', 'lavalux'] as SlotKind[]) slots[k] -= b.gear[k].length
        const divisions = [...node.divisions, { mission: loop.mission, plan, perHour: loop.perHour, existingId: d.id }]
        const child: Node = {
          pool: without(node.pool, keys),
          slots,
          divisions,
          total: input.alignMove
            ? valued(divisions, input).reduce((n, x) => n + score(strategy, x.perHour, x.plan), 0)
            : node.total + s,
          rank: 0
        }
        child.rank = child.total + (strategy === 'per-hour' ? potential(child, input, ordered) : 0)
        const sig = signature(child)
        if (seen.has(sig)) continue
        seen.add(sig)
        children.push(child)
      }
      const maxAtk = reach(node.pool, 'attack')
      const maxDef = reach(node.pool, 'defense')
      for (const m of ordered) {
        if (Date.now() > deadline) {
          outOfTime = true
          break
        }
        // Nothing this mission could pay would beat what this army already found for this step.
        if (strategy === 'per-hour' && width === 1 && ceiling.get(m.id)! <= bestHere) break
        // Out of reach for what is left: no need to solve it.
        if (m.minAtk > maxAtk || m.minDef > maxDef) continue
        // A mission with no requirement takes the smallest division there is.
        const target = m.minAtk > 0 || m.minDef > 0 ? { atk: m.minAtk, def: m.minDef } : { atk: 1, def: 0 }
        for (const variant of variants) {
          const plan = planMissionDivision(node.pool, target, input.forgeLevel, node.slots, { ...variant, gridMax: PLANNER_GRID })
          if (!plan) break
          const perHour = tlmPerHour(m, plan.bundle.move, input.market)
          if (perHour <= 0) break
          const s = score(strategy, perHour, plan)
          bestHere = Math.max(bestHere, s)
          const slots = { ...node.slots }
          for (const k of ['weapon', 'supply', 'lavalux'] as SlotKind[]) slots[k] -= plan.bundle.gear[k].length
          const divisions = [...node.divisions, { mission: m, plan, perHour }]
          const child: Node = {
            pool: without(node.pool, usedKeys(plan)),
            slots,
            divisions,
            total: input.alignMove
              ? valued(divisions, input).reduce((n, x) => n + score(strategy, x.perHour, x.plan), 0)
              : node.total + s,
            rank: 0
          }
          child.rank = child.total + (strategy === 'per-hour' ? potential(child, input, ordered) : 0)
          // The same divisions reached in another order (or by both weights) are the same army.
          const sig = signature(child)
          if (seen.has(sig)) continue
          seen.add(sig)
          children.push(child)
        }
      }
    }
    if (!children.length) break
    children.sort((x, y) => y.rank - x.rank)
    const keep = Date.now() - started > BEAM_BUDGET_MS ? 1 : width
    frontier = children.slice(0, keep)
    for (const c of frontier) if (earning(c, input) > earning(best, input)) best = c
    if (outOfTime) break
  }
  return { divisions: valued(best.divisions, input), perHour: earning(best, input), strategy }
}

/**
 * What each division earns when the ones on missions of the same length wait for the slowest of
 * them (alignMove): its mission's rate at that group's highest move cost.
 */
export function alignedDivisions(
  divisions: OptimizedDivision[],
  market: Market,
  anchors: { cooldownBase: number; move: number }[] = []
): OptimizedDivision[] {
  const slowest = new Map<number, number>()
  for (const a of anchors) slowest.set(a.cooldownBase, Math.max(slowest.get(a.cooldownBase) ?? 0, a.move))
  for (const d of divisions)
    slowest.set(d.mission.cooldownBase, Math.max(slowest.get(d.mission.cooldownBase) ?? 0, d.plan.bundle.move))
  return divisions.map((d) => ({ ...d, perHour: tlmPerHour(d.mission, slowest.get(d.mission.cooldownBase)!, market) }))
}

const valued = (divisions: OptimizedDivision[], input: OptimizeInput) =>
  input.alignMove ? alignedDivisions(divisions, input.market, input.anchors) : divisions

/** Move costs this close count as the same. */
const BALANCE_TOLERANCE = 3
const BALANCE_ROUNDS = 60
/** Unused mercenaries tried as replacements per round and side. */
const BALANCE_SPARES = 24
/** Under a move cap, move hardly counts: the division fills up to the cap with the weakest units. */
const CAPPED_MOVE_WEIGHT = 0.2
/** Caps tried when re-planning a group: the mean of its moves, then halfway up towards the slowest. */
const REPLAN_TRIES = 4

/**
 * Evens out the move costs of the divisions on missions of the same length by trading units of
 * the new ones: the slowest and the quickest swap a mercenary or a supply, one hands a unit over
 * when the other has room, the slowest swaps a mercenary for a quicker unused one or takes an
 * unused supply while a Forge slot is free, and the quickest swaps a mercenary for a slower unused
 * one or gives a supply up, whenever that narrows the gap and both still meet their missions.
 * Divisions kept as they are and the anchors (divisions out on a mission) cannot change, but they
 * count: the new ones are drawn towards them. Repeated until the gap is small or nothing helps.
 * Gear is re-dealt within each division as the solver does (evaluate).
 *
 * Trading alone cannot bring the slowest down: each division is built with hardly any strength to
 * spare, so handing a strong unit away fails its mission. So first the group is planned again as a
 * whole: every new division from the group's units and the unused pool, capped at the mean of the
 * group's moves (or the anchors' when there are any), the cap raised towards the slowest until all
 * of them fit under it. The trading then closes what is left.
 */
export function balanceMoves(divisions: OptimizedDivision[], input: OptimizeInput): OptimizedDivision[] {
  const market = input.market
  const out = [...divisions]
  const byLength = new Map<number, number[]>()
  out.forEach((d, i) => byLength.set(d.mission.cooldownBase, [...(byLength.get(d.mission.cooldownBase) ?? []), i]))
  const rebuilt = (d: OptimizedDivision, mercs: Candidate[], gear: Bundle['gear']): OptimizedDivision => {
    const ev = evaluate({ warlord: d.plan.bundle.warlord, mercs, gear })
    const bundle: Bundle = { ...d.plan.bundle, mercs, gear, ...ev }
    return { ...d, plan: { ...d.plan, bundle }, perHour: tlmPerHour(d.mission, bundle.move, market) }
  }
  const fits = (d: OptimizedDivision) =>
    d.plan.bundle.mercs.length >= 1 &&
    d.plan.bundle.mercs.length <= d.plan.bundle.warlord.slots &&
    d.plan.bundle.atk >= d.mission.minAtk &&
    d.plan.bundle.def >= d.mission.minDef
  const levelOk = (a: AssetRef) => Number(a.stats?.min_forge_level || 0) <= input.forgeLevel
  const asCandidates = (list: AssetRef[], used: Set<string>) =>
    list
      .filter((a) => !used.has(a.assetId) && levelOk(a))
      .map((a) => candidateOf(a))
      .filter((c): c is Candidate => !!c)

  /** Plans the group's new divisions again under one move cap, from their own units and the unused pool. */
  const replan = (members: number[], anchors: number[]) => {
    const moves = [...anchors, ...members.map((i) => out[i].plan.bundle.move)]
    const slowest = Math.max(...moves)
    const mean = anchors.length ? Math.max(...anchors) : moves.reduce((n, m) => n + m, 0) / moves.length
    if (slowest - Math.min(...moves) <= BALANCE_TOLERANCE) return
    const outside = new Set(out.flatMap((d, i) => (members.includes(i) ? [] : [...usedKeys(d.plan)])))
    const slotsOutside = { weapon: 0, supply: 0, lavalux: 0 }
    out.forEach((d, i) => {
      if (members.includes(i)) return
      for (const k of ['weapon', 'supply', 'lavalux'] as SlotKind[]) slotsOutside[k] += d.plan.bundle.gear[k].length
    })
    let cap = mean
    for (let attempt = 0; attempt < REPLAN_TRIES; attempt++) {
      let pool = without(input.pool, outside)
      const slots = { ...input.slotsFree }
      for (const k of ['weapon', 'supply', 'lavalux'] as SlotKind[]) slots[k] = Math.max(0, slots[k] - slotsOutside[k])
      const planned = new Map<number, MissionPlan>()
      // Slowest first: it has the first pick of the quick units.
      const order = [...members].sort((a, b) => out[b].plan.bundle.move - out[a].plan.bundle.move)
      for (const i of order) {
        const m = out[i].mission
        const target = m.minAtk > 0 || m.minDef > 0 ? { atk: m.minAtk, def: m.minDef } : { atk: 1, def: 0 }
        const plan = planMissionDivision(pool, target, input.forgeLevel, slots, {
          moveWeight: CAPPED_MOVE_WEIGHT,
          maxMove: Math.floor(cap + BALANCE_TOLERANCE),
          gridMax: PLANNER_GRID
        })
        if (!plan || plan.bundle.move > cap + BALANCE_TOLERANCE + 1e-9) break
        planned.set(i, plan)
        pool = without(pool, usedKeys(plan))
        for (const k of ['weapon', 'supply', 'lavalux'] as SlotKind[]) slots[k] -= plan.bundle.gear[k].length
      }
      if (planned.size === members.length) {
        for (const [i, plan] of planned)
          out[i] = { ...out[i], plan, perHour: tlmPerHour(out[i].mission, plan.bundle.move, market) }
        return
      }
      // Not all fit under this cap: raise it halfway towards the slowest and try again.
      cap = (cap + slowest) / 2
    }
  }

  for (const [base, all] of byLength) {
    const members = all.filter((i) => out[i].existingId == null)
    const anchors = (input.anchors ?? []).filter((a) => a.cooldownBase === base).map((a) => a.move)
    if (members.length === 0 || all.length + anchors.length < 2) continue
    replan(members, anchors)
    // Any key may come from any plan of the group once units travel between them.
    const assets = new Map<string, AssetRef>()
    for (const i of members) for (const [k, a] of out[i].plan.assets) assets.set(k, a)
    for (const i of members) out[i] = { ...out[i], plan: { ...out[i].plan, assets } }
    const withAsset = (c: Candidate, list: AssetRef[]) => {
      if (assets.has(c.key)) return
      const a = list.find((x) => x.assetId === c.key)
      if (a) assets.set(c.key, a)
    }
    const gapOf = (changes: Map<number, OptimizedDivision>) => {
      const moves = [...anchors, ...all.map((i) => (changes.get(i) ?? out[i]).plan.bundle.move)]
      return Math.max(...moves) - Math.min(...moves)
    }
    for (let round = 0; round < BALANCE_ROUNDS; round++) {
      const gap = gapOf(new Map())
      if (gap <= BALANCE_TOLERANCE) break
      const used = new Set(out.flatMap((d) => [...usedKeys(d.plan)]))
      const spareMercs = asCandidates(input.pool.mercenary, used)
      const quicker = [...spareMercs].sort((a, b) => a.move - b.move).slice(0, BALANCE_SPARES)
      const slower = [...spareMercs].sort((a, b) => b.move - a.move).slice(0, BALANCE_SPARES)
      const attached = members.reduce((n, i) => n + out[i].plan.bundle.gear.supply.length, 0)
      const spareSupplies =
        attached < input.slotsFree.supply
          ? asCandidates(input.pool.supply, used)
              .sort((a, b) => b.moveReduction - a.moveReduction)
              .slice(0, 10)
          : []
      const slow = members.reduce((a, b) => (out[a].plan.bundle.move >= out[b].plan.bundle.move ? a : b))
      const fast = members.reduce((a, b) => (out[a].plan.bundle.move <= out[b].plan.bundle.move ? a : b))
      let best: { gap: number; changes: Map<number, OptimizedDivision> } | null = null
      const consider = (changes: Map<number, OptimizedDivision>) => {
        for (const d of changes.values()) if (!fits(d)) return
        const g = gapOf(changes)
        if (g < gap - 1e-9 && (!best || g < best.gap)) best = { gap: g, changes }
      }
      const S = out[slow]
      const F = out[fast]
      const sb = S.plan.bundle
      const fb = F.plan.bundle
      const pair = (sd: OptimizedDivision, fd: OptimizedDivision) =>
        consider(
          new Map([
            [slow, sd],
            [fast, fd]
          ])
        )
      if (slow !== fast) {
        // Swap a mercenary of each, or the slowest hands one to a free slot of the quickest.
        for (let i = 0; i < sb.mercs.length; i++) {
          for (let j = 0; j < fb.mercs.length; j++) {
            const sm = [...sb.mercs]
            const fm = [...fb.mercs]
            ;[sm[i], fm[j]] = [fm[j], sm[i]]
            pair(rebuilt(S, sm, sb.gear), rebuilt(F, fm, fb.gear))
          }
          if (fb.mercs.length < fb.warlord.slots && sb.mercs.length > 1)
            pair(
              rebuilt(
                S,
                sb.mercs.filter((_, k) => k !== i),
                sb.gear
              ),
              rebuilt(F, [...fb.mercs, sb.mercs[i]], fb.gear)
            )
        }
        // Swap a supply (they cut move), or the quickest hands one to the slowest.
        for (let i = 0; i < sb.gear.supply.length; i++)
          for (let j = 0; j < fb.gear.supply.length; j++) {
            const sg = { ...sb.gear, supply: [...sb.gear.supply] }
            const fg = { ...fb.gear, supply: [...fb.gear.supply] }
            ;[sg.supply[i], fg.supply[j]] = [fg.supply[j], sg.supply[i]]
            pair(rebuilt(S, sb.mercs, sg), rebuilt(F, fb.mercs, fg))
          }
        if (sb.gear.supply.length < sb.mercs.length)
          for (let j = 0; j < fb.gear.supply.length; j++)
            pair(
              rebuilt(S, sb.mercs, { ...sb.gear, supply: [...sb.gear.supply, fb.gear.supply[j]] }),
              rebuilt(F, fb.mercs, { ...fb.gear, supply: fb.gear.supply.filter((_, k) => k !== j) })
            )
      }
      // The slowest alone: a quicker unused mercenary in place of any of its own; an unused supply.
      for (const spare of quicker) {
        withAsset(spare, input.pool.mercenary)
        for (let i = 0; i < sb.mercs.length; i++) {
          const sm = [...sb.mercs]
          sm[i] = spare
          consider(new Map([[slow, rebuilt(S, sm, sb.gear)]]))
        }
      }
      if (sb.gear.supply.length < sb.mercs.length)
        for (const spare of spareSupplies) {
          withAsset(spare, input.pool.supply)
          consider(new Map([[slow, rebuilt(S, sb.mercs, { ...sb.gear, supply: [...sb.gear.supply, spare] })]]))
        }
      // The quickest alone: a slower unused mercenary in place of any of its own; a supply given up.
      for (const spare of slower) {
        withAsset(spare, input.pool.mercenary)
        for (let j = 0; j < fb.mercs.length; j++) {
          const fm = [...fb.mercs]
          fm[j] = spare
          consider(new Map([[fast, rebuilt(F, fm, fb.gear)]]))
        }
      }
      for (let j = 0; j < fb.gear.supply.length; j++)
        consider(new Map([[fast, rebuilt(F, fb.mercs, { ...fb.gear, supply: fb.gear.supply.filter((_, k) => k !== j) })]]))
      if (!best) break
      const b: { gap: number; changes: Map<number, OptimizedDivision> } = best
      for (const [i, d] of b.changes) out[i] = d
    }
  }
  return out
}

// ---- Packing one more division of a mission ---------------------------------------------------

/**
 * The search fields divisions one at a time, each just strong enough when it is made. When several
 * divisions go on the same mission that can leave the last one short, because the early ones took
 * boosters (Lava Lux multiplies a mercenary's whole total, so it is worth most on the strongest)
 * without regard for the divisions still to come. This step takes the NFTs of the divisions on one
 * mission, plus what the army leaves unused (and, if it helps, the NFTs of one weaker division), and
 * packs them again into one more division of that mission: gear paired the way the contract pairs
 * it, then the strongest units shared out so each division just clears the mission. The army is
 * only replaced when it earns more.
 */

/** A mercenary with the gear it would carry, and what it adds to a division. */
interface PackUnit {
  merc: Candidate
  gear: Partial<Record<GearKind, Candidate>>
  atk: number
  def: number
  move: number
}

/** A unit's totals the way the contract adds them: merc and gear summed, times its Lava Lux. */
function unitOf(merc: Candidate, gear: PackUnit['gear']): PackUnit {
  const add = [merc, gear.weapon, gear.supply, gear.creature].filter((x): x is Candidate => !!x)
  const l = gear.lavalux
  return {
    merc,
    gear,
    atk: Math.floor(add.reduce((n, x) => n + x.atk, 0) * (l?.atkMult ?? 1)),
    def: Math.floor(add.reduce((n, x) => n + x.def, 0) * (l?.defMult ?? 1)),
    move: Math.round(Math.max(0, merc.move - (gear.supply?.moveReduction ?? 0)) * (l?.moveMult ?? 1))
  }
}

/**
 * A division plan from a warlord and units with their gear as given. The pairing is part of the
 * plan (the units are what gets assigned on chain), so it is kept as packed rather than paired again.
 */
function planOf(warlord: AssetRef, units: PackUnit[], assets: Map<string, AssetRef>): MissionPlan {
  const w: WarlordOption = {
    key: warlord.assetId,
    slots: Number(warlord.stats?.slots_max ?? 0),
    minLevel: Number(warlord.stats?.min_forge_level || 0),
    cost: 0,
    moveReduction: Number(warlord.stats?.movecost_reduction || 0)
  }
  const gearOf = (k: GearKind) => units.flatMap((u) => (u.gear[k] ? [u.gear[k]!] : []))
  const bundle: Bundle = {
    warlord: w,
    mercs: units.map((u) => u.merc),
    gear: { weapon: gearOf('weapon'), supply: gearOf('supply'), creature: gearOf('creature'), lavalux: gearOf('lavalux') },
    units: units.map((u) => ({ merc: u.merc, gear: u.gear, atk: u.atk, def: u.def, move: u.move })),
    atk: units.reduce((n, u) => n + u.atk, 0),
    def: units.reduce((n, u) => n + u.def, 0),
    // The warlord takes its reduction off the whole division.
    move: Math.max(0, units.reduce((n, u) => n + u.move, 0) - (w.moveReduction ?? 0)),
    cost: 0,
    nftCost: 0,
    slotCost: 0,
    forgeCost: 0,
    level: 0,
    slotsBought: { weapon: [], supply: [], lavalux: [] }
  }
  return { bundle, assets }
}

/**
 * The indexes of the items whose values add up to at least `target` with the least to spare, using
 * at most `maxItems` of them (and, among equally tight sets, the fewest); null when none reach it.
 * A subset sum over the reachable totals: fine for the few dozen units a division is chosen from.
 */
export function tightestSubset(values: number[], target: number, maxItems: number): number[] | null {
  const items = values.map((v, i) => ({ v: Math.max(0, Math.floor(v)), i })).filter((x) => x.v > 0)
  if (!items.length || maxItems <= 0) return null
  const top = Math.max(...items.map((x) => x.v))
  // Totals beyond target + the largest item never make the tightest set.
  const limit = Math.min(
    target + top,
    items.reduce((n, x) => n + x.v, 0)
  )
  if (limit < target) return null
  const INF = 0x7fff
  const n = items.length
  // fewest[k][s]: the fewest of the first k items that make exactly s.
  const fewest: Int16Array[] = [new Int16Array(limit + 1).fill(INF)]
  fewest[0][0] = 0
  for (let k = 1; k <= n; k++) {
    const prev = fewest[k - 1]
    const row = prev.slice()
    const v = items[k - 1].v
    for (let s = v; s <= limit; s++) if (prev[s - v] + 1 < row[s]) row[s] = prev[s - v] + 1
    fewest.push(row)
  }
  let best = -1
  for (let s = target; s <= limit; s++)
    if (fewest[n][s] <= maxItems) {
      best = s
      break
    }
  if (best < 0) return null
  // Walk back: an item is in the set when leaving it out cannot make the same total with as few.
  const chosen: number[] = []
  let s = best
  for (let k = n; k >= 1 && s > 0; k--) {
    if (fewest[k][s] === fewest[k - 1][s]) continue
    chosen.push(items[k - 1].i)
    s -= items[k - 1].v
  }
  return s === 0 ? chosen : null
}

/**
 * Like {@link tightestSubset}, for a division whose warlord takes `cut` off its move: a set that
 * clears `target` (with at most `slack` to spare over the tightest that can) and whose `moves` add
 * up to no more than `cut`, taking as much move as fits. A division then carries the slow units its
 * warlord cancels, so they do not pile up in the divisions still to fill. Null when no set stays
 * within the cut.
 */
export function tightestWithinCut(
  values: number[],
  moves: number[],
  target: number,
  cut: number,
  slack: number
): number[] | null {
  const items = values
    .map((v, i) => ({ v: Math.max(0, Math.floor(v)), m: Math.max(0, Math.round(moves[i])), i }))
    .filter((x) => x.v > 0 && x.m <= cut)
  if (!items.length || cut < 0) return null
  const limit = Math.min(
    target + Math.max(...items.map((x) => x.v)),
    items.reduce((n, x) => n + x.v, 0)
  )
  if (limit < target) return null
  // reach[k]: for each total s, a bit set per move m (0..cut) some subset of the first k items makes.
  const words = (cut >> 5) + 1
  const lastMask = (cut & 31) === 31 ? 0xffffffff : (1 << ((cut & 31) + 1)) - 1
  const reach: Uint32Array[] = [new Uint32Array((limit + 1) * words)]
  reach[0][0] = 1
  for (const { v, m } of items) {
    const prev = reach[reach.length - 1]
    const row = prev.slice()
    const ws = m >> 5
    const bs = m & 31
    for (let s = v; s <= limit; s++) {
      const src = (s - v) * words
      const dst = s * words
      // row[s] |= prev[s - v] << m, dropping moves above the cut.
      for (let w = words - 1; w >= ws; w--) {
        const lo = prev[src + w - ws]
        const carry = bs && w - ws - 1 >= 0 ? prev[src + w - ws - 1] >>> (32 - bs) : 0
        row[dst + w] |= ((lo << bs) | carry) >>> 0
      }
      row[dst + words - 1] &= lastMask
    }
    reach.push(row)
  }
  const final = reach[reach.length - 1]
  const has = (layer: Uint32Array, s: number, m: number) => (layer[s * words + (m >> 5)] >>> (m & 31)) & 1
  const maxMove = (s: number) => {
    for (let m = cut; m >= 0; m--) if (has(final, s, m)) return m
    return -1
  }
  let tight = -1
  for (let s = target; s <= limit && tight < 0; s++) if (maxMove(s) >= 0) tight = s
  if (tight < 0) return null
  let bestS = tight
  let bestM = maxMove(tight)
  for (let s = tight + 1; s <= Math.min(limit, tight + slack); s++) {
    const m = maxMove(s)
    if (m > bestM) {
      bestS = s
      bestM = m
    }
  }
  const chosen: number[] = []
  let s = bestS
  let m = bestM
  for (let k = items.length; k >= 1 && s > 0; k--) {
    if (has(reach[k - 1], s, m)) continue
    chosen.push(items[k - 1].i)
    s -= items[k - 1].v
    m -= items[k - 1].m
  }
  return s === 0 && m === 0 ? chosen : null
}

/**
 * `count` divisions of `mission` from `pool`, each meeting it, or null when the pool cannot. Gear
 * goes where it adds the most strength (weapons, creatures and supplies to the strongest
 * mercenaries, Lava Lux to the strongest of them with their gear), within the Forge slots `slots`;
 * then each division takes units until it clears the mission, finishing with the smallest unit that
 * completes it so little strength is wasted. Supplies left over cut move cost.
 */
export function packDivisions(
  pool: Record<Kind, AssetRef[]>,
  mission: MissionEconomics,
  count: number,
  slots: Record<SlotKind, number>,
  forgeLevel: number
): MissionPlan[] | null {
  const usable = (a: AssetRef) => Number(a.stats?.min_forge_level || 0) <= forgeLevel
  const assets = new Map<string, AssetRef>()
  const cands = (kind: Kind) =>
    pool[kind].filter(usable).flatMap((a) => {
      const c = candidateOf(a)
      if (!c) return []
      assets.set(a.assetId, a)
      return [c]
    })
  const warlords = pool.warlord
    .filter(usable)
    .filter((w) => Number(w.stats?.slots_max ?? 0) > 0)
    .sort(
      (a, b) =>
        Number(b.stats?.slots_max ?? 0) - Number(a.stats?.slots_max ?? 0) ||
        Number(b.stats?.movecost_reduction ?? 0) - Number(a.stats?.movecost_reduction ?? 0)
    )
    .slice(0, count)
  if (warlords.length < count) return null
  for (const w of warlords) assets.set(w.assetId, w)
  const capacity = warlords.reduce((n, w) => n + Number(w.stats?.slots_max ?? 0), 0)

  // Which strength the mission asks for decides what "strongest" means.
  const ta = Math.max(0, mission.minAtk)
  const td = Math.max(0, mission.minDef)
  const strength = (c: { atk: number; def: number }) =>
    ta > 0 && td > 0 ? c.atk / ta + c.def / td : td > 0 ? c.def : ta > 0 ? c.atk : c.atk + c.def
  const byStrength = (a: Candidate, b: Candidate) => strength(b) - strength(a)

  const mercs = cands('mercenary').sort(byStrength).slice(0, capacity)
  const gear: Partial<Record<GearKind, Candidate>>[] = mercs.map(() => ({}))
  const weapons = cands('weapon').sort(byStrength).slice(0, Math.max(0, slots.weapon))
  const creatures = cands('creature').sort(byStrength)
  const supplies = cands('supply')
    .sort((a, b) => byStrength(a, b) || b.moveReduction - a.moveReduction)
    .slice(0, Math.max(0, slots.supply))
  weapons.forEach((g, i) => i < gear.length && (gear[i].weapon = g))
  creatures.forEach((g, i) => i < gear.length && (gear[i].creature = g))
  // Supplies with strength to the strongest; the rest wait to cut move cost below.
  const strongSupplies = supplies.filter((s) => strength(s) > 0)
  const spareSupplies = supplies.filter((s) => strength(s) <= 0)
  strongSupplies.forEach((g, i) => i < gear.length && (gear[i].supply = g))
  // Lava Lux multiplies everything else, so it goes to the units strongest with their gear.
  const lava = cands('lavalux')
    .sort((a, b) => (b.atkMult ?? 1) + (b.defMult ?? 1) - ((a.atkMult ?? 1) + (a.defMult ?? 1)))
    .slice(0, Math.max(0, slots.lavalux))
  const order = mercs.map((m, i) => ({ i, s: strength(unitOf(m, gear[i])) })).sort((x, y) => y.s - x.s)
  lava.forEach((l, j) => order[j] && (gear[order[j].i].lavalux = l))
  const units = mercs.map((m, i) => unitOf(m, gear[i]))

  // Share the units out: smaller warlords first (they need the strong units), each division until it clears.
  const meets = (a: number, d: number) => a >= ta && d >= td && (ta > 0 || td > 0 || a > 0)
  const left = [...units].sort((a, b) => strength(b) - strength(a))
  const bins: { warlord: AssetRef; units: PackUnit[] }[] = []
  for (const warlord of [...warlords].reverse()) {
    const cap = Number(warlord.stats?.slots_max ?? 0)
    // A mission that asks for one stat: the exact set of units that clears it with the least to spare.
    if (ta > 0 !== td > 0) {
      const stat = ta > 0 ? 'atk' : 'def'
      const target = ta > 0 ? ta : td
      const cut = Number(warlord.stats?.movecost_reduction || 0)
      const within =
        cut > 0
          ? tightestWithinCut(
              left.map((u) => u[stat]),
              left.map((u) => u.move),
              target,
              cut,
              Math.max(1, Math.floor(target * 0.005))
            )
          : null
      const picked =
        within && within.length <= cap
          ? within
          : tightestSubset(
              left.map((u) => u[stat]),
              target,
              cap
            )
      if (!picked) return null
      const chosen = new Set(picked)
      bins.push({ warlord, units: left.filter((_, i) => chosen.has(i)) })
      for (let i = left.length - 1; i >= 0; i--) if (chosen.has(i)) left.splice(i, 1)
      continue
    }
    const bin: PackUnit[] = []
    let a = 0
    let d = 0
    while (!meets(a, d) && bin.length < cap && left.length) {
      const ra = Math.max(0, ta - a)
      const rd = Math.max(0, td - d)
      // The smallest unit that completes the division, if one does; otherwise the one that helps most.
      let pick = -1
      let pickSize = Infinity
      for (let i = 0; i < left.length; i++) {
        const u = left[i]
        if (u.atk >= ra && u.def >= rd) {
          const size = strength(u)
          if (size < pickSize) {
            pickSize = size
            pick = i
          }
        }
      }
      if (pick < 0) {
        let gain = -Infinity
        for (let i = 0; i < left.length; i++) {
          const u = left[i]
          const g = (ta ? Math.min(u.atk, ra) / ta : 0) + (td ? Math.min(u.def, rd) / td : 0)
          if (g > gain) {
            gain = g
            pick = i
          }
        }
      }
      const [u] = left.splice(pick, 1)
      bin.push(u)
      a += u.atk
      d += u.def
    }
    if (!meets(a, d)) return null
    bins.push({ warlord, units: bin })
  }

  // Supplies not used for strength, and those on units left out, cut the move of the units that have the most.
  const usedSupply = new Set(bins.flatMap((b) => b.units.flatMap((u) => (u.gear.supply ? [u.gear.supply.key] : []))))
  const spare = [...spareSupplies, ...strongSupplies.filter((s) => !usedSupply.has(s.key))].sort(
    (a, b) => b.moveReduction - a.moveReduction
  )
  const needy = bins
    .flatMap((b, bi) => b.units.map((u, ui) => ({ bi, ui, u })))
    .filter((x) => !x.u.gear.supply && x.u.move > 0)
    .sort((x, y) => y.u.move - x.u.move)
  spare.forEach((s, i) => {
    const x = needy[i]
    if (!x) return
    bins[x.bi].units[x.ui] = unitOf(x.u.merc, { ...x.u.gear, supply: s })
  })
  // Units left out give up supplies that went to a division, so no supply is in two places.
  const placed = new Set(bins.flatMap((b) => b.units.flatMap((u) => (u.gear.supply ? [u.gear.supply.key] : []))))
  left.forEach((u, i) => {
    if (u.gear.supply && placed.has(u.gear.supply.key)) left[i] = unitOf(u.merc, { ...u.gear, supply: undefined })
  })
  trimMove(bins, left, meets)

  const plans = bins.map((b) => planOf(b.warlord, b.units, assets))
  return plans.every((p) => meets(p.bundle.atk, p.bundle.def)) ? plans : null
}

/**
 * Packing by strength alone can leave a division with more move than its warlord takes off. This
 * lowers what is left over, keeping every division above the mission: units that are not needed
 * leave, and units swap with unused ones or with another division's where that moves less.
 */
function trimMove(bins: { warlord: AssetRef; units: PackUnit[] }[], left: PackUnit[], meets: (a: number, d: number) => boolean) {
  const cut = (b: (typeof bins)[number]) => Number(b.warlord.stats?.movecost_reduction || 0)
  const sum = (us: PackUnit[], k: 'atk' | 'def' | 'move') => us.reduce((n, u) => n + u[k], 0)
  const excess = (b: (typeof bins)[number], us = b.units) => Math.max(0, sum(us, 'move') - cut(b))
  const ok = (us: PackUnit[]) => meets(sum(us, 'atk'), sum(us, 'def'))
  for (let round = 0; round < 200; round++) {
    let done = false
    for (const b of bins) {
      const now = excess(b)
      if (now <= 0) continue
      // Drop the unit with the most move the division can do without.
      const drops = b.units.map((_, i) => i).sort((i, j) => b.units[j].move - b.units[i].move)
      for (const i of drops) {
        const rest = b.units.filter((_, k) => k !== i)
        if (b.units[i].move > 0 && ok(rest)) {
          left.push(b.units[i])
          b.units = rest
          done = true
          break
        }
      }
      if (done) break
      // Take a supply from where its move cut is wasted (an unused unit, or a division its warlord
      // already brings to no move) for the unit here that moves most without one.
      const bare = b.units
        .map((_, i) => i)
        .filter((i) => !b.units[i].gear.supply && b.units[i].move > 0)
        .sort((i, j) => b.units[j].move - b.units[i].move)
      const holders: { from: PackUnit[]; at: number; bin?: (typeof bins)[number] }[] = [
        ...left.flatMap((u, at) => (u.gear.supply ? [{ from: left, at }] : [])),
        ...bins
          .filter((o) => o !== b)
          .flatMap((o) => o.units.flatMap((u, at) => (u.gear.supply ? [{ from: o.units, at, bin: o }] : [])))
      ]
      for (const i of bare) {
        for (const h of holders) {
          const giver = h.from[h.at]
          const s = giver.gear.supply!
          const mine = b.units.map((x, k) => (k === i ? unitOf(x.merc, { ...x.gear, supply: s }) : x))
          if (excess(b, mine) >= now || !ok(mine)) continue
          const theirs = h.from.map((x, k) => (k === h.at ? unitOf(x.merc, { ...x.gear, supply: undefined }) : x))
          if (h.bin && (!ok(theirs) || excess(b, mine) + excess(h.bin, theirs) >= now + excess(h.bin))) continue
          b.units = mine
          if (h.bin) h.bin.units = theirs
          else left[h.at] = theirs[h.at]
          done = true
          break
        }
        if (done) break
      }
      if (done) break
      // Swap with an unused unit, or with another division's, when that lowers the move left over.
      for (let i = 0; i < b.units.length && !done; i++) {
        const u = b.units[i]
        for (let j = 0; j < left.length && !done; j++) {
          const v = left[j]
          if (v.move >= u.move) continue
          const mine = b.units.map((x, k) => (k === i ? v : x))
          if (ok(mine)) {
            b.units = mine
            left[j] = u
            done = true
          }
        }
        for (const o of bins) {
          if (o === b || done) continue
          for (let j = 0; j < o.units.length && !done; j++) {
            const v = o.units[j]
            if (v.move >= u.move) continue
            const mine = b.units.map((x, k) => (k === i ? v : x))
            const theirs = o.units.map((x, k) => (k === j ? u : x))
            if (excess(b, mine) + excess(o, theirs) < now + excess(o) && ok(mine) && ok(theirs)) {
              b.units = mine
              o.units = theirs
              done = true
            }
          }
        }
      }
      if (done) break
    }
    if (!done) return
  }
}

const keysOf = (d: OptimizedDivision) => usedKeys(d.plan)

/** The army with one more division of some mission, packed again from its NFTs, when that earns more. */
export function packMore(divisions: OptimizedDivision[], input: OptimizeInput): OptimizedDivision[] {
  const total = (ds: OptimizedDivision[]) => valued(ds, input).reduce((n, d) => n + d.perHour, 0)
  let best = divisions
  let bestTotal = total(divisions)
  // A few rounds: each extra division may make room for another.
  for (let round = 0; round < 4; round++) {
    let improved = false
    const usedAll = new Set(best.flatMap((d) => [...keysOf(d)]))
    const leftover = without(input.pool, usedAll)
    const missions = [...new Map(best.map((d) => [d.mission.id, d.mission])).values()]
    for (const mission of missions) {
      const group = best.filter((d) => d.mission.id === mission.id)
      const others = best.filter((d) => d.mission.id !== mission.id)
      // Also try giving up one of the weaker other divisions for its NFTs.
      const drops: (OptimizedDivision | null)[] = [null, ...[...others].sort((a, b) => a.perHour - b.perHour).slice(0, 3)]
      for (const drop of drops) {
        const keep = others.filter((d) => d !== drop)
        if (keep.length + group.length + 1 > input.maxDivisions) continue
        const freed = new Set([...group, ...(drop ? [drop] : [])].flatMap((d) => [...keysOf(d)]))
        const sub: Record<Kind, AssetRef[]> = {
          warlord: [...leftover.warlord],
          mercenary: [...leftover.mercenary],
          weapon: [...leftover.weapon],
          supply: [...leftover.supply],
          creature: [...leftover.creature],
          lavalux: [...leftover.lavalux]
        }
        for (const kind of Object.keys(sub) as Kind[])
          for (const a of input.pool[kind]) if (freed.has(a.assetId)) sub[kind].push(a)
        // Forge slots: what the input allows less what the divisions that stay already use.
        const slots = { ...input.slotsFree }
        for (const d of keep)
          for (const k of ['weapon', 'supply', 'lavalux'] as SlotKind[]) slots[k] -= d.plan.bundle.gear[k].length
        const plans = packDivisions(sub, mission, group.length + 1, slots, input.forgeLevel)
        if (!plans) continue
        const packed = plans.map((plan) => ({ mission, plan, perHour: tlmPerHour(mission, plan.bundle.move, input.market) }))
        if (packed.some((d) => d.perHour <= 0)) continue
        const candidate = [...keep, ...packed]
        const t = total(candidate)
        if (t > bestTotal + 1e-9) {
          best = candidate
          bestTotal = t
          improved = true
        }
      }
      if (improved) break
    }
    if (!improved) break
  }
  return best === divisions ? divisions : valued(best, input)
}

/**
 * Hands the warlords round once the army is planned. Warlords of the same kind take different
 * amounts of move off by their shine, and a reduction is worth most in the division with the most
 * move to cancel; building the divisions one by one cannot see that. Two new divisions swap
 * warlords, or one takes an unused warlord instead, whenever the army then earns more and every
 * warlord still has the slots for its mercenaries. The units and their gear stay as packed;
 * divisions kept as they are stay as they are.
 */
export function repairWarlords(divisions: OptimizedDivision[], input: OptimizeInput): OptimizedDivision[] {
  const total = (ds: OptimizedDivision[]) => valued(ds, input).reduce((n, d) => n + d.perHour, 0)
  const refs = new Map<string, AssetRef>()
  for (const w of input.pool.warlord) refs.set(w.assetId, w)
  for (const d of divisions) for (const [k, a] of d.plan.assets) refs.set(k, a)
  const option = (a: AssetRef): WarlordOption => ({
    key: a.assetId,
    slots: Number(a.stats?.slots_max ?? 0),
    minLevel: Number(a.stats?.min_forge_level || 0),
    cost: 0,
    moveReduction: Number(a.stats?.movecost_reduction || 0)
  })
  const led = (d: OptimizedDivision, w: WarlordOption): OptimizedDivision | null => {
    const b = d.plan.bundle
    if (w.slots < b.mercs.length) return null
    // The move before any warlord: the units' own, as packed.
    const raw = b.units.reduce((n, u) => n + u.move, 0)
    const bundle: Bundle = { ...b, warlord: w, move: Math.max(0, raw - (w.moveReduction ?? 0)) }
    const assets = new Map(d.plan.assets)
    assets.delete(b.warlord.key)
    const ref = refs.get(w.key)
    if (ref) assets.set(w.key, ref)
    return { ...d, plan: { bundle, assets }, perHour: tlmPerHour(d.mission, bundle.move, input.market) }
  }
  const used = new Set(divisions.map((d) => d.plan.bundle.warlord.key))
  let spare = input.pool.warlord
    .filter((a) => !used.has(a.assetId) && Number(a.stats?.min_forge_level || 0) <= input.forgeLevel)
    .map(option)
    .filter((w) => w.slots > 0)
  let best = [...divisions]
  let bestTotal = total(best)
  const movable = (d: OptimizedDivision) => d.existingId === undefined
  for (let round = 0; round < 60; round++) {
    let improved = false
    for (let i = 0; i < best.length && !improved; i++) {
      if (!movable(best[i])) continue
      for (let j = i + 1; j < best.length && !improved; j++) {
        if (!movable(best[j])) continue
        const a = led(best[i], best[j].plan.bundle.warlord)
        const b = led(best[j], best[i].plan.bundle.warlord)
        if (!a || !b) continue
        const next = best.map((d, k) => (k === i ? a : k === j ? b : d))
        const t = total(next)
        if (t > bestTotal + 1e-9) {
          best = next
          bestTotal = t
          improved = true
        }
      }
      for (let s = 0; s < spare.length && !improved; s++) {
        const a = led(best[i], spare[s])
        if (!a) continue
        const next = best.map((d, k) => (k === i ? a : d))
        const t = total(next)
        if (t > bestTotal + 1e-9) {
          spare = spare.map((w, k) => (k === s ? best[i].plan.bundle.warlord : w))
          best = next
          bestTotal = t
          improved = true
        }
      }
    }
    if (!improved) break
  }
  return bestTotal > total(divisions) + 1e-9 ? valued(best, input) : divisions
}

const earning = (n: Node, input: OptimizeInput) => valued(n.divisions, input).reduce((sum, d) => sum + d.perHour, 0)

/** The army plan that earns the most, over the strategies. */
/** budgetMs: how long the whole search may take (the extra passes are skipped when little is left). */
export function optimizeArmy(input: OptimizeInput, onProgress?: (p: Progress) => void, budgetMs = TOTAL_BUDGET_MS): ArmyPlan {
  const started = Date.now()
  const deadline = started + budgetMs
  // Leaving every existing division as it is: the floor any answer has to beat.
  const asIs: OptimizedDivision[] = []
  for (const d of input.existing ?? []) {
    const plan = planFromDivision(d)
    const loop = bestLoop(d, input.missions, input.market)
    if (plan && loop) asIs.push({ mission: loop.mission, plan, perHour: loop.perHour, existingId: d.id })
  }
  const asIsValued = valued(asIs, input)
  let best: ArmyPlan =
    asIs.length && asIs.length <= input.maxDivisions
      ? { divisions: asIsValued, perHour: asIsValued.reduce((n, d) => n + d.perHour, 0), strategy: 'per-hour' }
      : { divisions: [], perHour: 0, strategy: 'per-hour' }
  for (const strategy of STRATEGIES) {
    if (deadline - Date.now() < Math.min(EXTRA_PASS_MIN_MS, budgetMs * 0.4) && strategy !== 'per-hour') break
    const plan = search(input, strategy, strategy === 'per-hour' ? beamWidth(input) : 1, deadline, onProgress)
    if (plan.perHour > best.perHour + 1e-9) best = plan
  }
  // Then one more division of a mission the army already runs, packed again from its NFTs, if that earns more.
  {
    const divisions = packMore(best.divisions, input)
    if (divisions !== best.divisions) best = { ...best, divisions, perHour: divisions.reduce((n, d) => n + d.perHour, 0) }
  }
  if (input.alignMove) {
    // Then trade units between the new divisions of each length until their move costs are close.
    const divisions = alignedDivisions(balanceMoves(best.divisions, input), input.market, input.anchors)
    best = { ...best, divisions, perHour: divisions.reduce((n, d) => n + d.perHour, 0) }
  }
  // Last, the warlords go where their move reduction cancels the most.
  {
    const divisions = repairWarlords(best.divisions, input)
    if (divisions !== best.divisions) best = { ...best, divisions, perHour: divisions.reduce((n, d) => n + d.perHour, 0) }
  }
  return best
}
