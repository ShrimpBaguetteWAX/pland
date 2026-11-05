import type { AssetRef } from '@/data/assets'
import type { Division } from '@/data/game'

import type { Bundle, Candidate, Economy, SlotKind, SolveInput, WarlordOption } from './bundle'
import { isTokenLoop, meetsRequirements, tlmPerHour, type MissionEconomics } from './loop'
import type { Market } from './market'
import { kindOfCategory } from './stats'
import { divisionStats, rateFor, type StepKind, type UpgradeStep } from './upgrades'

/*
 * The Upgrade tab's deeper search: whole divisions rather than single NFTs. Each scenario is a
 * division solved by the Market builder's solver (the cheapest set of NFTs, Forge slots and level
 * that meets a mission's requirements, optionally under a move limit), from what the player owns
 * and what the market, the blends and the Forge offer:
 *
 *  - a new division for each requirement level of the missions running now;
 *  - each existing division rebuilt (its own NFTs free) to reach a better mission;
 *  - each existing division made faster on the mission it runs, with a move limit.
 *
 * The solves are slow, so they run in the solver's workers one by one with a progress bar.
 */

export type PlanSourceFrom = 'market' | 'reserve' | 'division' | 'wallet' | 'blend'

export interface PlanSource {
  from: PlanSourceFrom
  asset: AssetRef
  wax: number
}

export interface PlanScenario {
  id: string
  kind: 'new' | 'rebuild' | 'faster'
  /** The division rebuilt or made faster; unset for a new one. */
  division?: Division
  /** The mission whose requirements the solve aims at. */
  mission: MissionEconomics
  input: SolveInput
  sources: Map<string, PlanSource>
  /** A Division slot to buy first, when the allowance is used up. */
  extra: { wax: number; def: number } | null
  /** TLM per hour of the division as it is (0 for a new one) and its stats. */
  before: { atk: number; def: number; move: number; rate: number }
  /** Resource the plan takes: a free division place, or the division it rebuilds. */
  place: string
  /** Whether a slower plan for the same aim should also be tried with half the move. */
  tryFaster: boolean
}

export interface Plan {
  kind: 'plan'
  id: string
  scenario: PlanScenario
  bundle: Bundle
  mission: MissionEconomics | null
  wax: number
  after: { atk: number; def: number; move: number; rate: number }
  gain: { tlm: number; atk: number; def: number; move: number; places: number }
  steps: UpgradeStep[]
  uses: string[]
}

/** A solver candidate for one NFT, the way the Market builder makes them. */
export function candidateOf(key: string, a: AssetRef, cost: number): { item?: Candidate; warlord?: WarlordOption } {
  const st = a.stats
  const kind = kindOfCategory(st?.category)
  if (!st || !kind) return {}
  const minLevel = Number(st.min_forge_level || 0)
  if (kind === 'warlord')
    return Number(st.slots_max) > 0
      ? {
          warlord: {
            key,
            slots: Number(st.slots_max),
            minLevel,
            cost,
            moveReduction: Number(st.movecost_reduction || 0)
          }
        }
      : {}
  return {
    item: {
      key,
      kind,
      group: `${key.split(':')[0]}:${a.templateId}`,
      atk: Number(st.attack || 0),
      def: Number(st.defense || 0),
      move: Number(st.movecost || 0),
      moveReduction: Number(st.movecost_reduction || 0),
      ...(kind === 'lavalux'
        ? {
            atkMult: Number(st.attack_mult_bp || 10000) / 10000,
            defMult: Number(st.defense_mult_bp || 10000) / 10000,
            moveMult: Number(st.movecost_mult_bp || 10000) / 10000
          }
        : {}),
      minLevel,
      cost
    }
  }
}

/** Everything staked in a division: its warlord, its mercenaries and their gear. */
export const piecesOf = (d: Division): AssetRef[] =>
  [d.leader, ...d.units.flatMap((u) => [u.asset, ...Object.values(u.gear)])].filter((a): a is AssetRef => !!a)

export interface PlanPool {
  /** Offers anyone may use, keyed as the solver keys them, with their source. */
  shared: { key: string; source: PlanSource }[]
}

export interface ScenarioInput {
  divisions: Division[]
  missions: MissionEconomics[]
  market: Market
  pool: PlanPool
  /** The Forge as the solver sees it, with the gear of these divisions counted as in use. */
  economyFor: (freeing: Division | null) => Economy
  /** Free division places left in the allowance, and the next Division slot for sale if none. */
  freePlaces: number
  divSlot: { wax: number; def: number } | null
}

/** The scenarios to solve, the likeliest wins first. */
export function buildScenarios(x: ScenarioInput): PlanScenario[] {
  const active = x.missions.filter((m) => m.state === 'active' && isTokenLoop(m))
  // One aim per requirement level: the mission paying most per hour at a typical move.
  const levels = new Map<string, MissionEconomics>()
  for (const m of active) {
    const key = `${m.minAtk}/${m.minDef}`
    const cur = levels.get(key)
    if (!cur || tlmPerHour(m, 0, x.market) > tlmPerHour(cur, 0, x.market)) levels.set(key, m)
  }
  const aims = [...levels.values()].filter((m) => m.minAtk + m.minDef > 0 && tlmPerHour(m, 0, x.market) > 0)

  const shared = (extra: { key: string; source: PlanSource }[] = []) => {
    const sources = new Map<string, PlanSource>()
    const items: Candidate[] = []
    const warlords: WarlordOption[] = []
    for (const { key, source } of [...extra, ...x.pool.shared]) {
      if (sources.has(key)) continue
      const c = candidateOf(key, source.asset, source.wax)
      if (!c.item && !c.warlord) continue
      sources.set(key, source)
      if (c.item) items.push(c.item)
      if (c.warlord) warlords.push(c.warlord)
    }
    return { sources, items, warlords }
  }

  const out: PlanScenario[] = []
  const newPool = shared()
  const extra = x.freePlaces > 0 ? null : x.divSlot
  if (x.freePlaces > 0 || x.divSlot)
    for (const m of aims) {
      out.push({
        id: `new:${m.minAtk}/${m.minDef}`,
        kind: 'new',
        mission: m,
        input: { atk: m.minAtk, def: m.minDef, warlords: newPool.warlords, items: newPool.items, economy: x.economyFor(null) },
        sources: newPool.sources,
        extra,
        before: { atk: 0, def: 0, move: 0, rate: 0 },
        place: x.freePlaces > 0 ? 'newdiv' : 'divslot',
        tryFaster: true
      })
    }

  for (const d of x.divisions) {
    const base = divisionStats(d.units, d.leader)
    if (!base) continue
    const rate = rateFor(active, x.market, base.atk, base.def, base.move)
    const own = piecesOf(d).map((a) => ({ key: `div:${a.assetId}`, source: { from: 'division' as const, asset: a, wax: 0 } }))
    const pool = shared(own)
    const economy = x.economyFor(d)
    const before = { ...base, rate }
    // Better missions it does not reach yet, best first; the top few are worth a solve.
    const better = aims
      .filter((m) => !meetsRequirements(m, base.atk, base.def) && tlmPerHour(m, base.move, x.market) > rate)
      .sort((a, b) => tlmPerHour(b, base.move, x.market) - tlmPerHour(a, base.move, x.market))
      .slice(0, 3)
    for (const m of better)
      out.push({
        id: `rebuild:${d.id}:${m.minAtk}/${m.minDef}`,
        kind: 'rebuild',
        division: d,
        mission: m,
        input: { atk: m.minAtk, def: m.minDef, warlords: pool.warlords, items: pool.items, economy },
        sources: pool.sources,
        extra: null,
        before,
        place: `div:${d.id}`,
        tryFaster: true
      })
    // Faster on what it reaches now: the same requirements with half the move.
    const current = active
      .filter((m) => meetsRequirements(m, base.atk, base.def))
      .sort((a, b) => tlmPerHour(b, base.move, x.market) - tlmPerHour(a, base.move, x.market))[0]
    if (current && base.move > 1 && rate > 0)
      out.push({
        id: `faster:${d.id}`,
        kind: 'faster',
        division: d,
        mission: current,
        input: {
          atk: Math.max(1, current.minAtk),
          def: current.minDef,
          maxMove: Math.floor(base.move / 2),
          warlords: pool.warlords,
          items: pool.items,
          economy
        },
        sources: pool.sources,
        extra: null,
        before,
        place: `div:${d.id}`,
        tryFaster: false
      })
  }
  return out
}

/** The same aim again with half the move of the answer found, if that answer moves at all. */
export function fasterOf(s: PlanScenario, b: Bundle): PlanScenario | null {
  if (!s.tryFaster || b.move < 2) return null
  return { ...s, id: `${s.id}:fast`, input: { ...s.input, maxMove: Math.floor(b.move / 2) }, tryFaster: false }
}

const LABEL: Record<PlanSourceFrom, StepKind> = {
  market: 'market',
  reserve: 'owned',
  division: 'owned',
  wallet: 'owned',
  blend: 'blend'
}

const fmt = (n: number, d = 1) => (Number.isInteger(n) ? String(n) : n.toFixed(d))

/** What a solved scenario gives: the division it makes, what that earns, and how to get there. */
export function planOf(
  s: PlanScenario,
  b: Bundle,
  missions: MissionEconomics[],
  market: Market,
  forgeLevel: number
): Plan | null {
  const active = missions.filter((m) => m.state === 'active' && isTokenLoop(m))
  const rate = rateFor(active, market, b.atk, b.def, b.move)
  const mission =
    active
      .filter((m) => meetsRequirements(m, b.atk, b.def))
      .sort((x, y) => tlmPerHour(y, b.move, market) - tlmPerHour(x, b.move, market))[0] ?? null
  const wax = b.cost + (s.extra?.wax ?? 0)
  const gain = {
    tlm: rate - s.before.rate,
    atk: b.atk - s.before.atk,
    def: b.def - s.before.def,
    move: s.kind === 'new' ? 0 : s.before.move - b.move,
    places: 0
  }
  if (gain.tlm <= 1e-9) return null

  const keys = [b.warlord.key, ...b.mercs.map((m) => m.key), ...Object.values(b.gear).flatMap((g) => g.map((c) => c.key))]
  const used = keys.map((k) => s.sources.get(k)).filter((x): x is PlanSource => !!x)
  const count = (from: PlanSourceFrom[]) => used.filter((u) => from.includes(u.from))
  const steps: UpgradeStep[] = []
  if (s.extra) steps.push({ kind: 'forge', label: 'Division slot', detail: `${fmt(s.extra.def, 2)} DEF` })
  if (b.level > forgeLevel) steps.push({ kind: 'forge', label: `Forge level ${b.level}` })
  const slots = (Object.keys(b.slotsBought) as SlotKind[]).reduce((n, k) => n + b.slotsBought[k].length, 0)
  if (slots > 0)
    steps.push({
      kind: 'forge',
      label: `${slots} Forge slot${slots === 1 ? '' : 's'}`,
      detail: `${fmt(
        Object.values(b.slotsBought)
          .flat()
          .reduce((n, o) => n + o.def, 0),
        2
      )} DEF`
    })
  const owned = count(['reserve', 'wallet', 'division'])
  if (owned.length)
    steps.push({
      kind: LABEL.reserve,
      label: `${owned.length} of your NFTs`,
      detail: s.kind === 'new' ? 'reserve and wallet' : 'kept or moved in'
    })
  const bought = count(['market'])
  if (bought.length)
    steps.push({
      kind: 'market',
      label: `Buy ${bought.length} NFT${bought.length === 1 ? '' : 's'}`,
      detail: `${fmt(
        bought.reduce((n, u) => n + u.wax, 0),
        0
      )} WAX`
    })
  const blended = count(['blend'])
  if (blended.length)
    steps.push({
      kind: 'blend',
      label: `Blend ${blended.length}`,
      detail: `${fmt(
        blended.reduce((n, u) => n + u.wax, 0),
        0
      )} WAX`
    })

  // Rows clash when they need the same division place, or more copies of an owned NFT, listings of a
  // template or runs of a blend than there are: named the way single upgrades name them.
  const uses = [s.place]
  for (const k of keys) {
    const src = s.sources.get(k)
    if (!src || src.from === 'division') continue
    if (src.from === 'blend') uses.push(`blend:${k.split(':')[1]}`)
    else uses.push(`${src.from === 'market' ? 'sale' : src.from}:${src.asset.templateId}`)
  }
  return {
    kind: 'plan',
    id: s.id,
    scenario: s,
    bundle: b,
    mission,
    wax,
    after: { atk: b.atk, def: b.def, move: b.move, rate },
    gain,
    steps,
    uses
  }
}
