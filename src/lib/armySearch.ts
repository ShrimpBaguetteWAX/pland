import type { AssetRef } from '@/data/assets'
import type { Division } from '@/data/game'

import { candidateMissions, optimizeArmy, packDivisions, type OptimizeInput } from './armyOptimizer'
import type { SlotKind } from './bundle'
import { cycleNet, type MissionEconomics } from './loop'
import type { Market } from './market'
import { GEAR_KINDS, unitTotals, type GearKind, type Kind } from './stats'

/*
 * The army that earns the most TLM per hour, found by a global search over whole armies.
 *
 * A division earns its mission's net reward per cycle over the cycle's length (the mission's base
 * time plus ten seconds per point of move cost), flat per division. So the task is to hand every
 * staked warlord, mercenary and piece of gear to some division (or to none), give each division
 * the mission it earns the most on, and make the sum as large as it can be, within each warlord's
 * crew limit, the Forge slots the army owns and the number of divisions allowed.
 *
 * Building divisions one after another cannot see across them (a unit that makes one division a
 * little stronger may be the one another division needed), so this works on complete armies
 * instead: simulated annealing over small changes, each evaluated with the contract's own maths.
 * Changes that lose a little are accepted often early and rarely late, which lets the search take
 * a poor arrangement apart; it restarts from the best found several times. It starts from several
 * armies (the army as it is now, a greedy construction, and nothing at all), keeps whichever lineage
 * does best, finishes with a deterministic hill-climb, and checks every division of the answer
 * against the contract's formula, the mission it is meant for, the slots and the allowance. Every
 * division is valued at its own move cost (the player claims each as soon as it is back). With
 * move-matching on, the player wants divisions on missions of the same base length at the same
 * move cost: a spread among them costs the score dearly, so the search makes them match whenever
 * the cards allow it and only then picks the best-earning arrangement (divisions out on such a
 * mission count too).
 *
 * The random numbers are seeded: the same army gives the same answer.
 */

export interface SearchInput {
  /** Everything that may be rearranged. */
  pool: Record<Kind, AssetRef[]>
  /** The divisions whose cards are in the pool, as they stand now. */
  existing: Division[]
  missions: MissionEconomics[]
  market: Market
  forgeLevel: number
  /** Forge slots per gear kind not taken by divisions that stay as they are. */
  slotsFree: Record<SlotKind, number>
  /** Divisions allowed beyond the ones that stay. */
  maxDivisions: number
  /** Also balance the best army for move cost afterwards (see SearchResult.balanced). */
  alignMove: boolean
  /**
   * How much income the balancing may give up: TLM an hour per move point of spread beyond the
   * tolerance (default MATCH_COST). Infinity: closeness is all that counts, income only breaks ties.
   */
  matchWeight?: number
  /**
   * The goal of the balancing, in move points of spread within a length group (ten seconds each):
   * beyond it the spread costs matchWeight per point; within it only a token amount, so the divisions
   * are brought closer than the goal only when that costs next to nothing. Default: 30 (five minutes).
   */
  matchGoal?: number
  /** Once within the goal: TLM an hour per move point the balancing may still give up (default WITHIN_GOAL_COST; 0 stops at the goal). */
  withinGoalWeight?: number
  /** Divisions that stay out, by mission length and move: the pace their length group runs at. */
  anchors: { cooldownBase: number; move: number }[]
  /**
   * Time allowed in all, when `phases` is not given: split 35% coverage, the rest rearranging (and
   * balancing); Infinity runs each phase until it settles. The potential pass uses it for its sweep.
   */
  budgetMs: number
  /** Time per phase; Infinity means the full sweep (coverage) or until it settles (the others). */
  phases?: PhaseBudgets
  /** Work per phase; when given, no phase is cut by the clock (only Stop ends a search early). */
  effort?: Effort
  seed?: number
}

/**
 * How much work a search does, counted in work rather than time, so the same input and seed give
 * the same answer on any machine and under any load:
 *  - missions: how many missions the coverage sweep builds armies for, most promising first (every
 *    count of each); the missions the army already fields are always counted.
 *  - rounds: cooling rounds per starting point in the rearrange phase (it stops earlier once every
 *    lineage has gone cold).
 *  - balanceTurns: cooling turns of the balancing phase per starting point (it stops earlier once every run is cold).
 */
export interface Effort {
  missions: number
  /** Counts tried per mission around the likely one (and every count up to it on the way down). */
  counts: number
  /** Missions the rest of an army is filled in from, most promising first. */
  fill: number
  /** Partner missions an efficient mission is paired with. */
  partners: number
  rounds: number
  balanceTurns: number
  /** Coverage armies (whole armies, one per mission and count) the balancing also starts from, best balanced first. */
  balanceStarts: number
  /** Starting points the balancing works on side by side (the best deal always among them). */
  balanceRuns: number
  /** Rounds of the exchange pass (every card for every card between divisions and the reserve), each keeping the best exchange. */
  exchange: number
}
export const EFFORTS = {
  quick: { missions: 6, counts: 2, fill: 4, partners: 2, rounds: 2, balanceTurns: 6, balanceStarts: 4, balanceRuns: 3, exchange: 6 },
  normal: { missions: 12, counts: 4, fill: 6, partners: 3, rounds: 4, balanceTurns: 16, balanceStarts: 8, balanceRuns: 5, exchange: 15 },
  thorough: { missions: 30, counts: 8, fill: 10, partners: 6, rounds: 12, balanceTurns: 40, balanceStarts: 16, balanceRuns: 8, exchange: 40 }
} satisfies Record<string, Effort>
export type EffortLevel = keyof typeof EFFORTS

export interface PhaseBudgets {
  coverageMs: number
  annealMs: number
  balanceMs: number
}

export interface PlannedUnit {
  merc: AssetRef
  gear: Partial<Record<GearKind, AssetRef>>
  atk: number
  def: number
  move: number
}

export interface PlannedDivision {
  warlord: AssetRef
  units: PlannedUnit[]
  mission: MissionEconomics
  atk: number
  def: number
  move: number
  /** The move cost it is valued at: its own (kept for the page; equal to move). */
  pace: number
  perHour: number
  /** The division this warlord leads now, kept and adjusted rather than raised anew. */
  existingId?: number
  /** Exactly the division as it is now: nothing to sign for it. */
  unchanged: boolean
}

export interface SearchResult {
  divisions: PlannedDivision[]
  perHour: number
  /** What the same cards earn arranged as they are now. */
  nowPerHour: number
  /** What building division by division (the old deck's way) reaches from the same cards, for comparison. */
  greedyPerHour: number
  moves: number
  ms: number
  /** The search stopped because it stopped finding anything, not because time ran out. */
  converged: boolean
  warnings: string[]
  /** Why there was nothing to search, when that is the case. */
  reason?: string
  /**
   * Per mission, the most divisions of it the cards could field at once and what the whole army
   * earned with that many (the rest filled in around them), best first: what the search looked at.
   */
  tried: { mission: MissionEconomics; count: number; perHour: number }[]
  /**
   * With move-matching asked for: the best army balanced for move cost afterwards, as a second
   * answer. Divisions on missions of one base length are brought as close in move cost as the cards
   * allow without giving up much income; the player picks which of the two to sign.
   */
  balanced?: {
    divisions: PlannedDivision[]
    perHour: number
    warnings: string[]
    score?: number
    /** Every mission length within the goal. */
    goalReached?: boolean
    /** Why the goal was not reached, in plain words. */
    note?: string
  }
  /** What the search maximised for the main answer (TLM/h, less any balancing penalty: none there). */
  score?: number
  /** The seed this answer came from. */
  seed?: number
}

export interface SearchProgress {
  phase: 'starting' | 'greedy' | 'coverage' | 'annealing' | 'balancing' | 'polishing' | 'checking'
  /** 0–1 of the current phase's time; -1 when the phase has no limit. */
  pct: number
  /** Milliseconds so far, in all. */
  ms: number
  /** The current phase's time, ms (Infinity when it runs until it settles). */
  phaseMs: number
  best: number
  moves: number
}

// ---- The model: cards as numbers, missions as rates -----------------------------------------------

interface Card {
  ref: AssetRef
  atk: number
  def: number
  move: number
  /** Move a supply (or a warlord) takes off. */
  red: number
  /** Lava Lux multipliers. */
  am: number
  dm: number
  mm: number
  /** Crew a warlord leads. */
  slots: number
}

interface Mis {
  m: MissionEconomics
  minAtk: number
  minDef: number
  base: number
  /** Net TLM per cycle, DEF swapped at the pool's price. */
  net: number
  /** How strength is weighed when dealing gear for this mission. */
  wa: number
  wd: number
}

/** Gear kinds by index: the search works on small integers. */
const GK = GEAR_KINDS
const S = 1
const L = 3

interface Model {
  mercs: Card[]
  warlords: Card[]
  gear: Card[][]
  missions: Mis[]
  caps: number[]
  maxDivs: number
  alignMove: boolean
  /** Base length → the slowest move among divisions that stay out on a mission of that length. */
  anchors: Map<number, number>
  /**
   * Balancing only: the divisions and their missions are fixed. No division is raised, taken apart
   * or given another mission; cards may only move between the divisions and the pool, and a
   * division that stops meeting its mission makes the whole state invalid.
   */
  frozen?: boolean
  /**
   * Balancing only: per mission index, how many divisions the army must still field on it (those the
   * best answer fields on its real missions). Balancing trades income for closer move costs; it never
   * gives up a real division to get there. Small side divisions are not counted and may come and go.
   */
  keep?: Map<number, number>
  /** TLM an hour per move point of spread beyond the goal (see SearchInput.matchWeight). */
  matchCost: number
  /** Spread within a length group that counts as reached (see SearchInput.matchGoal). */
  matchGoal: number
  /** TLM an hour per move point of spread within the goal (see SearchInput.withinGoalWeight). */
  withinCost: number
}

const cardOf = (a: AssetRef): Card => {
  const s = a.stats!
  const bp = (v: number | undefined) => (v && v > 0 ? v / 10000 : 1)
  return {
    ref: a,
    atk: Number(s.attack || 0),
    def: Number(s.defense || 0),
    move: Number(s.movecost || 0),
    red: Number(s.movecost_reduction || 0),
    am: bp(s.attack_mult_bp),
    dm: bp(s.defense_mult_bp),
    mm: bp(s.movecost_mult_bp),
    slots: Number(s.slots_max || 0)
  }
}

function modelOf(input: SearchInput): Model {
  const ok = (a: AssetRef) => !!a.stats && Number(a.stats.min_forge_level || 0) <= input.forgeLevel
  const missions = candidateMissions(input.missions)
    .map((m) => ({ m, net: cycleNet(m, input.market) }))
    .filter((x) => x.net > 0)
    .map(({ m, net }) => ({
      m,
      minAtk: Math.max(0, m.minAtk),
      minDef: Math.max(0, m.minDef),
      base: m.cooldownBase,
      net,
      wa: m.minAtk > 0 ? 1 / m.minAtk : m.minDef > 0 ? 0 : 1,
      wd: m.minDef > 0 ? 1 / m.minDef : m.minAtk > 0 ? 0 : 1
    }))
  const anchors = new Map<number, number>()
  for (const a of input.anchors) anchors.set(a.cooldownBase, Math.max(anchors.get(a.cooldownBase) ?? 0, a.move))
  return {
    mercs: input.pool.mercenary.filter(ok).map(cardOf),
    warlords: input.pool.warlord.filter((a) => ok(a) && Number(a.stats!.slots_max || 0) > 0).map(cardOf),
    gear: GK.map((k) => input.pool[k].filter(ok).map(cardOf)),
    missions,
    caps: GK.map((k) => (k === 'creature' ? Infinity : Math.max(0, input.slotsFree[k as SlotKind]))),
    maxDivs: Math.max(0, input.maxDivisions),
    // The search itself values earnings only; balancing for move cost comes after, on a copy with this on.
    alignMove: false,
    anchors,
    matchCost: Number.isFinite(input.matchWeight) ? Math.max(MATCH_COST, input.matchWeight!) : input.matchWeight === Infinity ? 1e6 : MATCH_COST,
    matchGoal: Math.max(MATCH_TOLERANCE, input.matchGoal ?? MATCH_GOAL),
    withinCost: Math.max(0, input.withinGoalWeight ?? WITHIN_GOAL_COST)
  }
}

const rate = (mis: Mis, pace: number) => (mis.net * 3600) / (mis.base + 10 * pace)

// ---- The state: who is where ------------------------------------------------------------------

interface Div {
  /** Warlord index, or -1 for an empty place in the list. */
  w: number
  /** Mission index, or -1 when it meets none. */
  k: number
  mercs: number[]
  gear: number[][]
  atk: number
  def: number
  move: number
  /**
   * The gear pairing the division really has now (mercenary → gear index per kind), for a division
   * taken over as it stands: it is valued exactly as it is, not as the search would deal it. Gone
   * the moment a change touches the division.
   */
  fixed?: Map<number, number[]>
}

interface State {
  divs: Div[]
  /** Where each card is: a division index, or -1. */
  mAt: Int16Array
  wAt: Int16Array
  gAt: Int16Array[]
  /** Gear in use per kind, against the Forge slots. */
  used: number[]
}

const newDiv = (w: number): Div => ({ w, k: -1, mercs: [], gear: [[], [], [], []], atk: 0, def: 0, move: 0 })

function emptyState(M: Model): State {
  return {
    divs: [],
    mAt: new Int16Array(M.mercs.length).fill(-1),
    wAt: new Int16Array(M.warlords.length).fill(-1),
    gAt: M.gear.map((g) => new Int16Array(g.length).fill(-1)),
    used: [0, 0, 0, 0]
  }
}

const cloneState = (s: State): State => ({
  divs: s.divs.map((d) => ({ ...d, mercs: [...d.mercs], gear: d.gear.map((g) => [...g]), fixed: d.fixed && new Map(d.fixed) })),
  mAt: s.mAt.slice(),
  wAt: s.wAt.slice(),
  gAt: s.gAt.map((a) => a.slice()),
  used: [...s.used]
})

const live = (s: State) => {
  const out: number[] = []
  for (let i = 0; i < s.divs.length; i++) if (s.divs[i].w >= 0) out.push(i)
  return out
}

// ---- Evaluating a division: the contract's maths, gear dealt the sensible way ---------------------

/**
 * Deals a division's gear to its mercenaries and adds the division up the way the contract does:
 * per mercenary (card + equipment + supply + creature) times its Lava Lux, rounded down, and the move
 * (card minus the supply's cut, never below nothing) times the Lava Lux, rounded down; the warlord then
 * takes its own cut off the whole. Equipment and creatures go to the strongest mercenaries for the
 * mission at hand, supplies to the ones with the most move to cut, Lava Lux to the units strongest
 * once they carry their gear. With `out` the pairing is written down as well.
 */
function evalDiv(M: Model, d: Div, out?: PlannedUnit[], picks?: number[][]): void {
  const n = d.mercs.length
  if (!n) {
    d.atk = d.def = d.move = 0
    return
  }
  const mis = d.k >= 0 ? M.missions[d.k] : null
  const wa = mis ? mis.wa : 1
  const wd = mis ? mis.wd : 1
  const mercs = M.mercs
  const str = (i: number) => wa * mercs[d.mercs[i]].atk + wd * mercs[d.mercs[i]].def
  // Ties broken by card index everywhere: a division is worth the same whatever order its cards sit in.
  const byStrength = Array.from({ length: n }, (_, i) => i).sort((a, b) => str(b) - str(a) || d.mercs[a] - d.mercs[b])
  const pick: number[][] = [new Array(n).fill(-1), new Array(n).fill(-1), new Array(n).fill(-1), new Array(n).fill(-1)]
  const sorted = (kind: number, key: (c: Card) => number) => [...d.gear[kind]].sort((a, b) => key(M.gear[kind][b]) - key(M.gear[kind][a]) || a - b)
  // Flat attack, defense and move per unit from the mercenary, its equipment and its creature; the
  // supply and the Lava Lux come after, since where they go depends on these.
  const fa = new Array<number>(n)
  const fd = new Array<number>(n)
  const fm = new Array<number>(n)
  const flat = () => {
    for (let i = 0; i < n; i++) {
      const m = mercs[d.mercs[i]]
      let a = m.atk
      let df = m.def
      let mv = m.move
      let red = 0
      for (const kind of [0, 1, 2]) {
        const g = pick[kind][i]
        if (g < 0) continue
        const c = M.gear[kind][g]
        a += c.atk
        df += c.def
        mv += c.move
        red += c.red
      }
      fa[i] = a
      fd[i] = df
      fm[i] = Math.max(0, mv - red)
    }
  }
  const strength = (i: number) => wa * fa[i] + wd * fd[i]
  const byFlatOrder = () => Array.from({ length: n }, (_, i) => i).sort((a, b) => strength(b) - strength(a) || d.mercs[a] - d.mercs[b])
  if (d.fixed) {
    for (let i = 0; i < n; i++) {
      const f = d.fixed.get(d.mercs[i])
      if (f) for (let kind = 0; kind < 4; kind++) pick[kind][i] = f[kind]
    }
    flat()
  } else {
    // Equipment and creatures: strongest to strongest.
    for (const kind of [0, 2]) sorted(kind, (c) => wa * c.atk + wd * c.def).forEach((g, j) => j < n && (pick[kind][byStrength[j]] = g))
    flat()
    /*
     * A Lava Lux multiplies the unit's move as well as its attack and defense (Basic Suite: 1.16×
     * attack, 1.70× move), so the best units carry the best of everything: the Lava Lux goes to the
     * units strongest with their flat gear, and a supply saves most on a unit that carries one
     * (its cut is multiplied too, and a unit at no move pays nothing for the multiplier). Supplies
     * are dealt by what each one saves, the carriers' multipliers counted.
     */
    const lux = sorted(L, (c) => c.am + c.dm)
    const byFlat = byFlatOrder()
    const carrier = new Set<number>()
    lux.forEach((_, j) => j < n && carrier.add(byFlat[j]))
    // Supplies: to the carriers first (their attack is multiplied too, and their move cut is
    // multiplied), the slowest of them first; then to the slowest of the rest. The biggest cut first.
    const bySupply = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => Number(carrier.has(b)) - Number(carrier.has(a)) || fm[b] - fm[a] || strength(b) - strength(a) || d.mercs[a] - d.mercs[b]
    )
    sorted(S, (c) => c.red).forEach((g, j) => j < n && (pick[S][bySupply[j]] = g))
    flat()
    // The Lava Lux placed two ways: by flat strength, and by flat strength among the units with no
    // move left first. With a mission known, the placement that meets it at less move wins; otherwise
    // the stronger one. (Without a mission the stats only serve to find one; it is run again with it.)
    if (lux.length) {
      const order = byFlatOrder()
      const zeroFirst = [...order].sort((a, b) => Number(fm[a] > 0) - Number(fm[b] > 0) || order.indexOf(a) - order.indexOf(b))
      const assign = (o: number[]) => {
        const out = new Array<number>(n).fill(-1)
        lux.forEach((g, j) => j < n && (out[o[j]] = g))
        return out
      }
      const total = (pl: number[]) => {
        let a = 0
        let df = 0
        let mv = 0
        for (let i = 0; i < n; i++) {
          const l = pl[i] >= 0 ? M.gear[L][pl[i]] : null
          a += Math.floor(fa[i] * (l?.am ?? 1) + 1e-9)
          df += Math.floor(fd[i] * (l?.dm ?? 1) + 1e-9)
          mv += Math.floor(fm[i] * (l?.mm ?? 1) + 1e-9)
        }
        return { a, df, mv }
      }
      const A = assign(order)
      const same = zeroFirst.every((v, j) => j >= lux.length || v === order[j])
      pick[L] = A
      if (!same) {
        const B = assign(zeroFirst)
        const ta = total(A)
        const tb = total(B)
        const meets = (t: { a: number; df: number }) => !!mis && t.a >= mis.minAtk && t.df >= mis.minDef
        const str = (t: { a: number; df: number }) => wa * t.a + wd * t.df
        const useB = mis ? (meets(ta) && meets(tb) ? tb.mv < ta.mv || (tb.mv === ta.mv && str(tb) > str(ta)) : meets(tb)) : str(tb) > str(ta)
        if (useB) pick[L] = B
      }
    }
  }
  let atk = 0
  let def = 0
  let move = 0
  for (let i = 0; i < n; i++) {
    const l = pick[L][i] >= 0 ? M.gear[L][pick[L][i]] : null
    // Rounded down per unit, as the contract does.
    const ua = Math.floor(fa[i] * (l?.am ?? 1) + 1e-9)
    const ud = Math.floor(fd[i] * (l?.dm ?? 1) + 1e-9)
    const um = Math.floor(fm[i] * (l?.mm ?? 1) + 1e-9)
    atk += ua
    def += ud
    move += um
    if (out) {
      const gear: PlannedUnit['gear'] = {}
      GK.forEach((k, kind) => pick[kind][i] >= 0 && (gear[k] = M.gear[kind][pick[kind][i]].ref))
      out.push({ merc: mercs[d.mercs[i]].ref, gear, atk: ua, def: ud, move: um })
    }
  }
  d.atk = atk
  d.def = def
  d.move = Math.max(0, move - M.warlords[d.w].red)
  if (picks) picks.splice(0, picks.length, ...pick.map((x) => [...x]))
}

/**
 * Re-pairs a division's gear with its own mercenaries, cards staying where they are: every unit is
 * rounded down on its own (after its Lava Lux), so who carries which weapon, supply, creature and Lava
 * Lux can move the division a point or two, which the dealing rules in evalDiv do not look for. Swaps
 * of one kind of gear between two units (or onto a unit without one) are kept while the score rises;
 * it starts from the dealt pairing and, when given, from the player's own pairing. True when it helped.
 */
function repairDiv(M: Model, s: State, di: number, hint?: Map<number, number[]>, deadline = Infinity): boolean {
  const d = s.divs[di]
  const n = d.mercs.length
  if (d.w < 0 || d.k < 0 || n < 2) return false
  const base = objective(M, s).real
  if (base < -1e8) return false
  const was = { atk: d.atk, def: d.def, move: d.move, fixed: d.fixed }
  const mis = M.missions[d.k]
  const score = (pick: number[][]) => {
    d.fixed = new Map(d.mercs.map((m, i) => [m, pick.map((x) => x[i])]))
    evalDiv(M, d)
    // The division must still meet its mission (the unfrozen score does not check that by itself).
    if (d.atk < mis.minAtk || d.def < mis.minDef) return -Infinity
    return objective(M, s).real
  }
  const measure = (pick: number[][]) => {
    d.fixed = new Map(d.mercs.map((m, i) => [m, pick.map((x) => x[i])]))
    evalDiv(M, d)
    return { atk: d.atk, def: d.def, move: d.move, ok: d.atk >= mis.minAtk && d.def >= mis.minDef }
  }
  const swap = (x: number[], i: number, j: number) => {
    const t = x[i]
    x[i] = x[j]
    x[j] = t
  }
  type Sw = { kind: number; i: number; j: number; move: number; lift: number }
  const climb = (pick: number[][]) => {
    let v = score(pick)
    for (let outer = 0; outer < 6; outer++) {
      // One swap at a time, while any helps.
      for (let pass = 0; pass < 20; pass++) {
        let better = false
        for (let kind = 0; kind < 4; kind++) {
          const x = pick[kind]
          for (let i = 0; i < n; i++)
            for (let j = i + 1; j < n; j++) {
              if (x[i] === x[j]) continue
              swap(x, i, j)
              const w = score(pick)
              if (w > v + 1e-9) {
                v = w
                better = true
              } else swap(x, i, j)
            }
        }
        if (!better) break
      }
      /*
       * Two swaps at once: a tight division (a few attack to spare) blocks every single swap that
       * would save a move point, because each one drops it below its mission. So the swaps that save
       * move but fall short are paired with the swaps that lift attack or defense, bounded lists of
       * each, and the best pair is kept. Then the single swaps again.
       */
      if (n > 60 || Date.now() > deadline) break
      const cur = measure(pick)
      // Only a tight division needs it: with attack or defense to spare, the single swaps already found what there is.
      const slackA = mis.minAtk ? (cur.atk - mis.minAtk) / mis.minAtk : 1
      const slackD = mis.minDef ? (cur.def - mis.minDef) / mis.minDef : 1
      if (Math.min(slackA, slackD) > 0.05) break
      const savers: Sw[] = []
      const lifters: Sw[] = []
      for (let kind = 0; kind < 4; kind++) {
        const x = pick[kind]
        for (let i = 0; i < n; i++)
          for (let j = i + 1; j < n; j++) {
            if (x[i] === x[j]) continue
            swap(x, i, j)
            const m = measure(pick)
            swap(x, i, j)
            const sw: Sw = { kind, i, j, move: m.move, lift: m.atk - cur.atk + (m.def - cur.def) }
            if (m.move < cur.move && !m.ok) savers.push(sw)
            if (m.atk > cur.atk || m.def > cur.def) lifters.push(sw)
          }
      }
      savers.sort((a, b) => a.move - b.move || a.kind - b.kind || a.i - b.i || a.j - b.j)
      lifters.sort((a, b) => b.lift - a.lift || a.kind - b.kind || a.i - b.i || a.j - b.j)
      savers.length = Math.min(savers.length, 40)
      lifters.length = Math.min(lifters.length, 40)
      let found: { a: Sw; b: Sw; v: number } | null = null
      for (const a of savers)
        for (const b of lifters) {
          if (a.kind === b.kind && a.i === b.i && a.j === b.j) continue
          swap(pick[a.kind], a.i, a.j)
          swap(pick[b.kind], b.i, b.j)
          const w = score(pick)
          swap(pick[b.kind], b.i, b.j)
          swap(pick[a.kind], a.i, a.j)
          if (w > v + 1e-9 && (!found || w > found.v + 1e-9)) found = { a, b, v: w }
        }
      if (!found) break
      swap(pick[found.a.kind], found.a.i, found.a.j)
      swap(pick[found.b.kind], found.b.i, found.b.j)
      v = score(pick)
    }
    return { pick, v }
  }
  const dealt: number[][] = []
  evalDiv(M, d, undefined, dealt)
  const starts = [dealt]
  if (hint) {
    // The player's own pairing where its gear is in this division; the rest of the gear on units without that kind.
    const own = [0, 1, 2, 3].map(() => new Array<number>(n).fill(-1))
    let any = false
    for (let kind = 0; kind < 4; kind++) {
      const left = new Set(d.gear[kind])
      d.mercs.forEach((m, i) => {
        const g = hint.get(m)?.[kind] ?? -1
        if (g >= 0 && left.has(g)) {
          own[kind][i] = g
          left.delete(g)
          any = true
        }
      })
      for (const g of left) {
        const i = own[kind].indexOf(-1)
        if (i >= 0) own[kind][i] = g
      }
    }
    if (any) starts.push(own)
  }
  let best: { pick: number[][]; v: number } | null = null
  for (const st of starts) {
    const res = climb(st.map((x) => [...x]))
    if (!best || res.v > best.v + 1e-9) best = res
  }
  if (best && best.v > base + 1e-9) {
    score(best.pick)
    return true
  }
  Object.assign(d, was)
  return false
}

/**
 * Balancing's last step: cards a division does not need come out (weakest first, only while the
 * score does not fall), then new divisions are raised from what is left over on the missions the
 * army fields, kept only when the whole army scores better. A fresh deal packs every mercenary into
 * its divisions before the gear goes in, so without this the small side divisions never come back.
 */
function topUp(M: Model, M2: Model, input: SearchInput, s: State, from: Mis[]): void {
  const log: Undo[] = []
  for (const di of live(s)) {
    const d = s.divs[di]
    if (d.k < 0) continue
    const mis = M.missions[d.k]
    const str = (m: number) => mis.wa * M.mercs[m].atk + mis.wd * M.mercs[m].def
    for (const m of [...d.mercs].sort((a, b) => str(a) - str(b) || a - b)) {
      if (d.mercs.length <= 1) break
      const before = objective(M2, s).real
      const mark = log.length
      moveMerc(s, m, -1, log)
      shedGear(s, di, log)
      refresh(M2, s, di, log)
      if (objective(M2, s).real < before - 1e-9) undoTo(log, mark)
    }
  }
  const trial = cloneState(s)
  const slots = { ...input.slotsFree }
  for (const kk of ['weapon', 'supply', 'lavalux'] as SlotKind[]) slots[kk] = Math.max(0, slots[kk] - trial.used[GK.indexOf(kk)])
  fillGreedy(M, input, trial, placedIn(M, trial), slots, Infinity, from)
  if (objective(M2, trial).real > objective(M2, s).real + 1e-9) Object.assign(s, trial)
}

/** repairDiv on every division, again while any of them helped (closer move costs can open more). */
function repairAll(M: Model, s: State, hint?: Map<number, number[]>, deadline = Infinity): void {
  for (let pass = 0; pass < 4; pass++) {
    let any = false
    for (const di of live(s)) if (repairDiv(M, s, di, hint, deadline)) any = true
    if (!any) break
  }
}

/** The mission the division earns the most on right now, or -1 when it meets none. */
function pickMission(M: Model, s: State, di: number): void {
  const d = s.divs[di]
  if (M.frozen) {
    // The mission stays, even while the division falls short of it: the objective counts that against
    // the state (and no such state is ever an answer), so the search can pass through and come back.
    return
  }
  let best = -1
  let bestRate = 0
  if (d.mercs.length) {
    for (let k = 0; k < M.missions.length; k++) {
      const mis = M.missions[k]
      if (d.atk < mis.minAtk || d.def < mis.minDef) continue
      const r = rate(mis, d.move)
      if (r > bestRate) {
        bestRate = r
        best = k
      }
    }
  }
  d.k = best
}

/** Weight of the nudge that pulls a division that meets nothing towards meeting something. */
const GUIDE = 0.1
/** Move-matching: this much spread within a length group (30 s of lock) is never worth chasing... */
const MATCH_TOLERANCE = 3
/** ...up to the goal (five minutes unless the player sets another) it costs only this much per point... */
const WITHIN_GOAL_COST = 0.25
/** The goal, in move points, when the player sets none. */
const MATCH_GOAL = 30
/**
 * ...and beyond the goal every move point of spread costs this much TLM an hour in the score (the
 * player can raise it): far more than a move point is worth in earnings. Balancing keeps every
 * division, so this only ever trades income for closer move costs, never a division.
 */
const MATCH_COST = 2

/**
 * What the search climbs. `earn` is what the army earns an hour, every division at its own move
 * cost. `real` is the score: the earning less, with move-matching, the cost of any spread of move
 * costs within a length group (divisions out on a mission of that length count too). `guided` adds
 * a nudge for divisions that meet no mission yet, in proportion to how close they are, so that a
 * half-built division is worth more than a scattered one.
 */
function objective(M: Model, s: State): { earn: number; real: number; guided: number } {
  let earn = 0
  let guide = 0
  // Balancing only: what the divisions that no longer meet their mission would have earned, and more
  // the further short they are. Such a state is never an answer, but the walk may pass through it.
  let short = 0
  let broken = false
  const groups = new Map<number, number[]>()
  if (M.alignMove) for (const [base, move] of M.anchors) groups.set(base, [move])
  for (const d of s.divs) {
    if (d.w < 0) continue
    if (d.k >= 0) {
      const mis = M.missions[d.k]
      if (M.frozen && !(d.mercs.length && d.atk >= mis.minAtk && d.def >= mis.minDef)) {
        const lack = Math.max(0, mis.minAtk ? 1 - d.atk / mis.minAtk : 0, mis.minDef ? 1 - d.def / mis.minDef : 0)
        short += Math.max(rate(mis, d.move) * (1 + 4 * lack), M.alignMove ? M.matchCost * (30 + 150 * lack) : 0)
        broken = true
        continue
      }
      earn += rate(mis, d.move)
      if (M.alignMove) {
        const g = groups.get(mis.base)
        if (g) g.push(d.move)
        else groups.set(mis.base, [d.move])
      }
    } else if (M.frozen) {
      broken = true
    } else if (d.mercs.length) {
      let near = 0
      for (const mis of M.missions) {
        const ratio = Math.min(1, mis.minAtk ? d.atk / mis.minAtk : 1, mis.minDef ? d.def / mis.minDef : 1)
        const v = ratio * ratio * rate(mis, d.move)
        if (v > near) near = v
      }
      guide += GUIDE * near
    }
  }
  if (M.keep) {
    const have = new Map<number, number>()
    for (const d of s.divs) {
      if (d.w < 0 || d.k < 0 || !M.keep.has(d.k)) continue
      const mis = M.missions[d.k]
      if (d.mercs.length && d.atk >= mis.minAtk && d.def >= mis.minDef) have.set(d.k, (have.get(d.k) ?? 0) + 1)
    }
    for (const [k, n] of M.keep) {
      const missing = n - (have.get(k) ?? 0)
      if (missing > 0) {
        broken = true
        short += missing * Math.max(2 * rate(M.missions[k], 0), M.alignMove ? M.matchCost * 200 : 0)
      }
    }
  }
  let penalty = 0
  // The walk's own gradient: the spread only sees the two extreme divisions; the distance of every
  // division from the group's middle tells the walk which way to go in between.
  let dev = 0
  if (M.alignMove)
    for (const moves of groups.values()) {
      if (moves.length < 2) continue
      const spread = Math.max(...moves) - Math.min(...moves)
      if (moves.length > 2) {
        const sorted = [...moves].sort((a, b) => a - b)
        const mid = sorted[Math.floor(sorted.length / 2)]
        for (const m of sorted) dev += Math.abs(m - mid)
      }
      const beyond = Math.max(0, spread - M.matchGoal)
      const within = Math.min(Math.max(0, spread - MATCH_TOLERANCE), M.matchGoal - MATCH_TOLERANCE)
      penalty += M.matchCost * beyond + M.withinCost * within
    }
  // Frozen: every division must still stand and meet its mission for the state to count at all.
  const real = broken ? -1e9 : earn - penalty
  return { earn, real, guided: earn - penalty - short + guide - M.matchCost * 0.02 * dev }
}

// ---- Changes to the state, each undoable ---------------------------------------------------------

type Undo = () => void

/** Removes one value from a small array by swapping the last one in. */
function pull(list: number[], v: number) {
  const i = list.indexOf(v)
  const last = list.pop()!
  if (i < list.length) list[i] = last
}

function moveMerc(s: State, m: number, to: number, log: Undo[]) {
  const from = s.mAt[m]
  if (from >= 0) pull(s.divs[from].mercs, m)
  if (to >= 0) s.divs[to].mercs.push(m)
  s.mAt[m] = to
  log.push(() => {
    if (to >= 0) pull(s.divs[to].mercs, m)
    if (from >= 0) s.divs[from].mercs.push(m)
    s.mAt[m] = from
  })
}

function moveGear(s: State, kind: number, g: number, to: number, log: Undo[]) {
  const from = s.gAt[kind][g]
  if (from >= 0) pull(s.divs[from].gear[kind], g)
  else s.used[kind]++
  if (to >= 0) s.divs[to].gear[kind].push(g)
  else s.used[kind]--
  s.gAt[kind][g] = to
  log.push(() => {
    if (to >= 0) pull(s.divs[to].gear[kind], g)
    else s.used[kind]++
    if (from >= 0) s.divs[from].gear[kind].push(g)
    else s.used[kind]--
    s.gAt[kind][g] = from
  })
}

function setWarlord(s: State, di: number, w: number, log: Undo[]) {
  const d = s.divs[di]
  const prev = d.w
  if (prev >= 0) s.wAt[prev] = -1
  d.w = w
  if (w >= 0) s.wAt[w] = di
  log.push(() => {
    if (w >= 0) s.wAt[w] = -1
    d.w = prev
    if (prev >= 0) s.wAt[prev] = di
  })
}

/** A place in the list for a new division: a hole, or one more. */
function openDiv(s: State, w: number, log: Undo[]): number {
  let di = s.divs.findIndex((d) => d.w < 0)
  if (di < 0) {
    di = s.divs.length
    s.divs.push(newDiv(-1))
    log.push(() => {
      s.divs.pop()
    })
  }
  setWarlord(s, di, w, log)
  return di
}

/** Takes a division apart: cards to the pool, the warlord too, the place left empty. */
function dissolve(s: State, di: number, log: Undo[]) {
  const d = s.divs[di]
  for (const m of [...d.mercs]) moveMerc(s, m, -1, log)
  for (let kind = 0; kind < 4; kind++) for (const g of [...d.gear[kind]]) moveGear(s, kind, g, -1, log)
  setWarlord(s, di, -1, log)
  refresh(null, s, di, log)
}

/** Gear a division no longer has mercenaries for goes back to the pool. */
function shedGear(s: State, di: number, log: Undo[]) {
  const d = s.divs[di]
  for (let kind = 0; kind < 4; kind++) while (d.gear[kind].length > d.mercs.length) moveGear(s, kind, d.gear[kind][d.gear[kind].length - 1], -1, log)
}

/**
 * Re-evaluates a division after a change (and remembers what it was, for the undo). The gear is
 * dealt for the division's mission and the mission picked from the result, so the two are run
 * again until they agree. `keepFixed` leaves an existing division's own pairing in place.
 */
function refresh(M: Model | null, s: State, di: number, log: Undo[], keepFixed = false) {
  const d = s.divs[di]
  const was = { k: d.k, atk: d.atk, def: d.def, move: d.move, fixed: d.fixed }
  log.push(() => Object.assign(d, was))
  if (!keepFixed) d.fixed = undefined
  if (M && d.w >= 0) {
    for (let round = 0; round < 3; round++) {
      const before = d.k
      evalDiv(M, d)
      pickMission(M, s, di)
      if (d.k === before || d.fixed || M.frozen) break
    }
  } else {
    d.k = -1
    d.atk = d.def = d.move = 0
  }
}

// ---- The moves the search tries ---------------------------------------------------------------

/** mulberry32: small, fast, seeded. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rng = () => number
const pickOne = <T>(list: T[], r: Rng) => list[Math.floor(r() * list.length)]

/** Picks a target for a card: another live division, or the pool. */
function target(s: State, from: number, r: Rng, poolShare = 0.25): number {
  const ds = live(s).filter((i) => i !== from)
  if (from >= 0 && (!ds.length || r() < poolShare)) return -1
  if (!ds.length) return -2
  return pickOne(ds, r)
}

const room = (M: Model, s: State, di: number) => M.warlords[s.divs[di].w].slots - s.divs[di].mercs.length

/** One of the two or three slowest (or quickest) cards of a list, at random. */
function slowest(M: Model, list: number[], r: Rng, quickest = false): number {
  const top = [...list].sort((a, b) => (quickest ? M.mercs[a].move - M.mercs[b].move : M.mercs[b].move - M.mercs[a].move) || a - b)
  return top[Math.floor(r() * Math.min(3, top.length))]
}

/**
 * Balancing: a change aimed straight at the spread. Within one mission length the slowest division
 * and the quickest (or two picked at random) exchange cards so the gap can narrow: a slow card for
 * a quick one, a card over, a supply across or swapped for a stronger one, attack across so the slow
 * division can spare a card. The general moves still run beside this.
 */
function balancingMove(M: Model, s: State, r: Rng, log: Undo[]): number[] | null {
  const groups = new Map<number, number[]>()
  for (const di of live(s)) {
    const d = s.divs[di]
    if (d.k < 0) continue
    const base = M.missions[d.k].base
    const g = groups.get(base)
    if (g) g.push(di)
    else groups.set(base, [di])
  }
  const wide = [...groups.values()].filter((g) => g.length > 1)
  if (!wide.length) return null
  const dis = pickOne(wide, r)
  let slow = dis[0]
  let fast = dis[0]
  if (r() < 0.7) {
    for (const di of dis) {
      if (s.divs[di].move > s.divs[slow].move) slow = di
      if (s.divs[di].move < s.divs[fast].move) fast = di
    }
  } else {
    slow = pickOne(dis, r)
    fast = pickOne(dis, r)
  }
  if (slow === fast) return null
  const S_ = s.divs[slow]
  const F_ = s.divs[fast]
  const x = r()
  if (x < 0.45) {
    if (!S_.mercs.length || !F_.mercs.length) return null
    const a = slowest(M, S_.mercs, r)
    const b = slowest(M, F_.mercs, r, true)
    if (M.mercs[a].move <= M.mercs[b].move) return null
    moveMerc(s, a, fast, log)
    moveMerc(s, b, slow, log)
    for (const di of [slow, fast]) {
      shedGear(s, di, log)
      refresh(M, s, di, log)
    }
    compensate(M, s, slow, fast, log)
  } else if (x < 0.65) {
    if (S_.mercs.length < 2 || room(M, s, fast) <= 0) return null
    moveMerc(s, slowest(M, S_.mercs, r), fast, log)
    for (const di of [slow, fast]) {
      shedGear(s, di, log)
      refresh(M, s, di, log)
    }
    compensate(M, s, slow, fast, log)
  } else if (x < 0.85) {
    if (!F_.gear[S].length) return null
    const g = pickOne(F_.gear[S], r)
    if (S_.gear[S].length < S_.mercs.length) moveGear(s, S, g, slow, log)
    else {
      if (!S_.gear[S].length) return null
      const h = pickOne(S_.gear[S], r)
      if (M.gear[S][g].red <= M.gear[S][h].red) return null
      moveGear(s, S, h, fast, log)
      moveGear(s, S, g, slow, log)
    }
  } else {
    const kinds = [0, 2].filter((k) => F_.gear[k].length && S_.gear[k].length < S_.mercs.length)
    if (!kinds.length) return null
    const kind = pickOne(kinds, r)
    moveGear(s, kind, pickOne(F_.gear[kind], r), slow, log)
    if (S_.mercs.length > 1 && r() < 0.7) moveMerc(s, slowest(M, S_.mercs, r), room(M, s, fast) > 0 && r() < 0.5 ? fast : -1, log)
  }
  for (const di of [slow, fast]) {
    shedGear(s, di, log)
    refresh(M, s, di, log)
  }
  return [slow, fast]
}

/**
 * One random change, applied to the state; `log` undoes it. Returns the divisions it touched, or
 * null when it could not be made (the change is then not in the log).
 */
function randomMove(M: Model, s: State, r: Rng, log: Undo[]): number[] | null {
  // Frozen (balancing): only cards move; the divisions, their warlords and missions stay. Two changes
  // in five go straight at the spread.
  if (M.frozen && r() < 0.4) return balancingMove(M, s, r, log)
  const x = M.frozen ? r() * 0.78 : r()
  const touched = new Set<number>()
  const done = () => {
    for (const di of touched) {
      shedGear(s, di, log)
      refresh(M, s, di, log)
    }
    return [...touched]
  }
  if (x < 0.26) {
    // A mercenary to another division or to the pool.
    if (!M.mercs.length) return null
    const m = Math.floor(r() * M.mercs.length)
    const from = s.mAt[m]
    const to = target(s, from, r)
    if (to === -2 || (to >= 0 && room(M, s, to) <= 0)) return null
    moveMerc(s, m, to, log)
    if (from >= 0) touched.add(from)
    if (to >= 0) touched.add(to)
    return done()
  }
  if (x < 0.42) {
    // Two mercenaries change places (at least one is in a division).
    if (M.mercs.length < 2) return null
    const a = Math.floor(r() * M.mercs.length)
    const b = Math.floor(r() * M.mercs.length)
    const da = s.mAt[a]
    const db = s.mAt[b]
    if (a === b || da === db) return null
    moveMerc(s, a, db, log)
    moveMerc(s, b, da, log)
    if (da >= 0) touched.add(da)
    if (db >= 0) touched.add(db)
    return done()
  }
  if (x < 0.6) {
    // A piece of gear to another division or to the pool.
    const kinds = [0, 1, 2, 3].filter((k) => M.gear[k].length)
    if (!kinds.length) return null
    const kind = pickOne(kinds, r)
    const g = Math.floor(r() * M.gear[kind].length)
    const from = s.gAt[kind][g]
    const to = target(s, from, r)
    if (to === -2) return null
    if (to >= 0) {
      const d = s.divs[to]
      if (d.gear[kind].length >= d.mercs.length) return null
      if (from < 0 && s.used[kind] >= M.caps[kind]) return null
    }
    moveGear(s, kind, g, to, log)
    if (from >= 0) touched.add(from)
    if (to >= 0) touched.add(to)
    return done()
  }
  if (x < 0.7) {
    // Two pieces of the same kind change places.
    const kinds = [0, 1, 2, 3].filter((k) => M.gear[k].length > 1)
    if (!kinds.length) return null
    const kind = pickOne(kinds, r)
    const a = Math.floor(r() * M.gear[kind].length)
    const b = Math.floor(r() * M.gear[kind].length)
    const da = s.gAt[kind][a]
    const db = s.gAt[kind][b]
    if (a === b || da === db) return null
    moveGear(s, kind, a, db, log)
    moveGear(s, kind, b, da, log)
    if (da >= 0) touched.add(da)
    if (db >= 0) touched.add(db)
    return done()
  }
  if (x < 0.78) {
    // A few mercenaries together from one division to another (or to the pool).
    const ds = live(s).filter((i) => s.divs[i].mercs.length > 1)
    if (!ds.length) return null
    const from = pickOne(ds, r)
    const to = target(s, from, r)
    if (to === -2) return null
    const n = Math.min(1 + Math.floor(r() * 3), s.divs[from].mercs.length - 1, to >= 0 ? room(M, s, to) : 99)
    if (n <= 0) return null
    const pool = [...s.divs[from].mercs]
    for (let i = 0; i < n; i++) {
      const m = pool.splice(Math.floor(r() * pool.length), 1)[0]
      moveMerc(s, m, to, log)
    }
    touched.add(from)
    if (to >= 0) touched.add(to)
    return done()
  }
  if (x < 0.84) {
    // Warlords change places: two divisions, or a division and an unused warlord.
    const ds = live(s)
    if (!ds.length) return null
    const di = pickOne(ds, r)
    const d = s.divs[di]
    const spare: number[] = []
    for (let w = 0; w < M.warlords.length; w++) if (s.wAt[w] < 0) spare.push(w)
    if (ds.length > 1 && (!spare.length || r() < 0.5)) {
      const dj = pickOne(ds.filter((i) => i !== di), r)
      const e = s.divs[dj]
      if (M.warlords[d.w].slots < e.mercs.length || M.warlords[e.w].slots < d.mercs.length) return null
      const wi = d.w
      const wj = e.w
      setWarlord(s, di, -1, log)
      setWarlord(s, dj, wi, log)
      setWarlord(s, di, wj, log)
      touched.add(di)
      touched.add(dj)
      return done()
    }
    if (!spare.length) return null
    const w = pickOne(spare, r)
    if (M.warlords[w].slots < d.mercs.length) return null
    setWarlord(s, di, w, log)
    touched.add(di)
    return done()
  }
  if (x < 0.88) {
    // A new division: an unused warlord and a few mercenaries, from the pool or out of a division.
    if (live(s).length >= M.maxDivs) return null
    const spare: number[] = []
    for (let w = 0; w < M.warlords.length; w++) if (s.wAt[w] < 0) spare.push(w)
    if (!spare.length) return null
    const w = pickOne(spare, r)
    const free: number[] = []
    for (let m = 0; m < M.mercs.length; m++) if (s.mAt[m] < 0) free.push(m)
    const di = openDiv(s, w, log)
    const want = Math.min(M.warlords[w].slots, 1 + Math.floor(r() * 4))
    if (free.length) {
      for (let i = 0; i < want && free.length; i++) moveMerc(s, free.splice(Math.floor(r() * free.length), 1)[0], di, log)
    } else {
      // Split a division: half of a random one comes over.
      const ds = live(s).filter((i) => i !== di && s.divs[i].mercs.length > 1)
      if (!ds.length) return null
      const from = pickOne(ds, r)
      const pool = [...s.divs[from].mercs]
      const n = Math.min(want, Math.floor(pool.length / 2))
      for (let i = 0; i < n; i++) moveMerc(s, pool.splice(Math.floor(r() * pool.length), 1)[0], di, log)
      touched.add(from)
    }
    touched.add(di)
    return done()
  }
  if (x < 0.94) {
    // A division raised for one mission in a single step (see raiseFor).
    const out = raiseFor(M, s, r, log)
    if (!out) return null
    for (const di of out) touched.add(di)
    return done()
  }
  if (x < 0.97) {
    // A division taken apart.
    const ds = live(s)
    if (!ds.length) return null
    dissolve(s, pickOne(ds, r), log)
    return []
  }
  // The weakest mercenary of a division leaves it: less move for the same mission, often.
  const ds = live(s).filter((i) => s.divs[i].mercs.length > 1)
  if (!ds.length) return null
  const di = pickOne(ds, r)
  const d = s.divs[di]
  const mis = d.k >= 0 ? M.missions[d.k] : null
  const wa = mis ? mis.wa : 1
  const wd = mis ? mis.wd : 1
  let weakest = d.mercs[0]
  let least = Infinity
  for (const m of d.mercs) {
    const v = wa * M.mercs[m].atk + wd * M.mercs[m].def
    if (v < least) {
      least = v
      weakest = m
    }
  }
  moveMerc(s, weakest, -1, log)
  touched.add(di)
  return done()
}

/**
 * A new division built for one mission in one go: an unused warlord takes mercenaries, strongest
 * for that mission first, from the pool and then from one other division, and gear from the pool,
 * until it meets the mission. One small step at a time could never get there (a half-built
 * division earns nothing, and the division it draws from may stop earning), so this is the move
 * that turns one big division into several smaller ones, or the other way round. Returns the
 * divisions it touched, or null when it could not be done (the caller undoes the partial work).
 */
function raiseFor(M: Model, s: State, r: Rng, log: Undo[]): number[] | null {
  if (live(s).length >= M.maxDivs || !M.missions.length) return null
  const spare: number[] = []
  for (let w = 0; w < M.warlords.length; w++) if (s.wAt[w] < 0) spare.push(w)
  if (!spare.length) return null
  const k = Math.floor(r() * M.missions.length)
  const mis = M.missions[k]
  const w = pickOne(spare, r)
  const di = openDiv(s, w, log)
  const d = s.divs[di]
  d.k = k
  const strength = (m: number) => mis.wa * M.mercs[m].atk + mis.wd * M.mercs[m].def
  const pool: number[] = []
  for (let m = 0; m < M.mercs.length; m++) if (s.mAt[m] < 0) pool.push(m)
  pool.sort((a, b) => strength(b) - strength(a))
  const donors = live(s).filter((i) => i !== di && s.divs[i].mercs.length > 1)
  const donor = donors.length ? pickOne(donors, r) : -1
  const fromDonor = donor >= 0 ? [...s.divs[donor].mercs].sort((a, b) => strength(b) - strength(a)) : []
  const cand = [...pool, ...fromDonor]
  const slots = M.warlords[w].slots
  const meets = () => d.mercs.length > 0 && d.atk >= mis.minAtk && d.def >= mis.minDef
  const gearStrength = (kind: number, g: number) => {
    const c = M.gear[kind][g]
    return kind === L ? c.am + c.dm : mis.wa * c.atk + mis.wd * c.def
  }
  let ci = 0
  for (let guard = 0; guard < 200 && !meets(); guard++) {
    if (d.mercs.length < slots && ci < cand.length) {
      moveMerc(s, cand[ci++], di, log)
      evalDiv(M, d)
      continue
    }
    // No mercenary left to take: gear from the pool, the strongest first, one piece per unit.
    let added = false
    for (const kind of [0, 2, L, S]) {
      if (d.gear[kind].length >= d.mercs.length || s.used[kind] >= M.caps[kind]) continue
      let best = -1
      let bestV = 0
      for (let g = 0; g < M.gear[kind].length; g++) {
        if (s.gAt[kind][g] >= 0) continue
        const v = gearStrength(kind, g)
        if (v > bestV) {
          bestV = v
          best = g
        }
      }
      if (best < 0) continue
      moveGear(s, kind, best, di, log)
      evalDiv(M, d)
      added = true
      break
    }
    if (!added) break
  }
  if (!meets()) return null
  return donor >= 0 ? [di, donor] : [di]
}

const rollback = (log: Undo[]) => {
  for (let i = log.length - 1; i >= 0; i--) log[i]()
  log.length = 0
}
/** Undoes everything logged since `mark`. */
const undoTo = (log: Undo[], mark: number) => {
  for (let i = log.length - 1; i >= mark; i--) log[i]()
  log.length = mark
}

// ---- Annealing ----------------------------------------------------------------------------------

interface Best {
  state: State
  real: number
}

/** Moves per cooling round: enough for the temperature to matter, few enough to restart often. */
const ROUND_MOVES = 250_000

/**
 * One cooling round from `s`: the temperature falls from t0 to t1 over the round. Every change is
 * kept when it helps and, when it hurts, with a chance that shrinks with the loss and the cold.
 * `best` is updated whenever the real earning beats it. Returns the moves tried.
 */
function anneal(
  M: Model,
  s: State,
  t0: number,
  t1: number,
  r: Rng,
  best: Best,
  deadline: number,
  onBest?: () => void,
  steps = ROUND_MOVES
): number {
  const log: Undo[] = []
  let cur = objective(M, s).guided
  let tried = 0
  const ratio = t1 / t0
  for (let step = 0; step < steps; step++) {
    if ((step & 2047) === 0 && Date.now() > deadline) break
    const touched = randomMove(M, s, r, log)
    if (!touched) {
      rollback(log)
      continue
    }
    tried++
    const next = objective(M, s)
    const d = next.guided - cur
    if (d >= 0 || r() < Math.exp(d / (t0 * Math.pow(ratio, step / steps)))) {
      cur = next.guided
      log.length = 0
      if (next.real > best.real + 1e-9) {
        best.real = next.real
        best.state = cloneState(s)
        onBest?.()
      }
    } else rollback(log)
  }
  return tried
}

/** A starting temperature at which half of the losing changes from here would still be taken. */
function temperature(M: Model, s: State, r: Rng): number {
  const trial = cloneState(s)
  const log: Undo[] = []
  const base = objective(M, trial).guided
  const losses: number[] = []
  for (let i = 0; i < (M.frozen ? 6000 : 600) && losses.length < 200; i++) {
    if (!randomMove(M, trial, r, log)) {
      rollback(log)
      continue
    }
    const o = objective(M, trial)
    const d = o.guided - base
    // Balancing: most random changes leave a division short; their cost is not the scale that matters.
    if (d < 0 && !(M.frozen && o.real < -1e8)) losses.push(-d)
    rollback(log)
  }
  if (!losses.length) return 1
  losses.sort((a, b) => a - b)
  return losses[Math.floor(losses.length / 2)] / Math.LN2 || 1
}

// ---- Hill-climbing at the end -------------------------------------------------------------------

/**
 * Deterministic first-improvement climb over every single change (a mercenary or piece of gear to
 * each division or the pool, warlords exchanged, the weakest mercenary out), until nothing helps.
 * The annealing leaves little, but this makes the answer a true local optimum.
 */
function polish(M: Model, s: State, deadline: number): number {
  const log: Undo[] = []
  let cur = objective(M, s).real
  let moves = 0
  const apply = (change: () => number[]) => {
    const touched = change()
    for (const di of touched) {
      shedGear(s, di, log)
      refresh(M, s, di, log)
    }
    const next = objective(M, s).real
    if (next > cur + 1e-9) {
      cur = next
      log.length = 0
      return true
    }
    rollback(log)
    return false
  }
  for (let round = 0; round < 50 && Date.now() < deadline; round++) {
    let improved = false
    const targets = [-1, ...live(s)]
    for (let m = 0; m < M.mercs.length && !improved; m++)
      for (const to of targets) {
        const from = s.mAt[m]
        if (to === from || (to >= 0 && room(M, s, to) <= 0)) continue
        if (apply(() => (moveMerc(s, m, to, log), [from, to].filter((i) => i >= 0)))) {
          improved = true
          break
        }
      }
    for (let kind = 0; kind < 4 && !improved; kind++)
      for (let g = 0; g < M.gear[kind].length && !improved; g++)
        for (const to of targets) {
          const from = s.gAt[kind][g]
          if (to === from) continue
          if (to >= 0 && (s.divs[to].gear[kind].length >= s.divs[to].mercs.length || (from < 0 && s.used[kind] >= M.caps[kind]))) continue
          if (apply(() => (moveGear(s, kind, g, to, log), [from, to].filter((i) => i >= 0)))) {
            improved = true
            break
          }
        }
    const ds = live(s)
    for (let i = 0; i < ds.length && !improved; i++)
      for (let j = i + 1; j < ds.length && !improved; j++) {
        const a = s.divs[ds[i]]
        const b = s.divs[ds[j]]
        if (M.warlords[a.w].slots < b.mercs.length || M.warlords[b.w].slots < a.mercs.length) continue
        improved = apply(() => {
          const wa = a.w
          const wb = b.w
          setWarlord(s, ds[i], -1, log)
          setWarlord(s, ds[j], wa, log)
          setWarlord(s, ds[i], wb, log)
          return [ds[i], ds[j]]
        })
      }
    for (let w = 0; w < M.warlords.length && !improved; w++) {
      if (s.wAt[w] >= 0) continue
      for (const di of ds) {
        if (M.warlords[w].slots < s.divs[di].mercs.length) continue
        if (apply(() => (setWarlord(s, di, w, log), [di]))) {
          improved = true
          break
        }
      }
    }
    if (!improved) break
    moves++
  }
  return moves
}

// ---- Starting armies ------------------------------------------------------------------------------

/** Indexes by asset id, to turn divisions and plans into states. */
function indexes(M: Model) {
  const m = new Map(M.mercs.map((c, i) => [c.ref.assetId, i]))
  const w = new Map(M.warlords.map((c, i) => [c.ref.assetId, i]))
  const g = M.gear.map((list) => new Map(list.map((c, i) => [c.ref.assetId, i])))
  return { m, w, g }
}

/** The army as it stands: every existing division that still has a warlord in the pool. */
function asIsState(M: Model, input: SearchInput): State {
  const s = emptyState(M)
  const ix = indexes(M)
  const log: Undo[] = []
  for (const d of input.existing) {
    const w = d.leader ? ix.w.get(d.leader.assetId) : undefined
    if (w === undefined) continue
    const di = openDiv(s, w, log)
    const fixed = new Map<number, number[]>()
    for (const u of d.units) {
      const m = ix.m.get(u.asset.assetId)
      if (m === undefined || s.divs[di].mercs.length >= M.warlords[w].slots) continue
      moveMerc(s, m, di, log)
      const pairing = [-1, -1, -1, -1]
      GK.forEach((k, kind) => {
        const g = u.gear[k] ? ix.g[kind].get(u.gear[k]!.assetId) : undefined
        if (g !== undefined && s.used[kind] < M.caps[kind]) {
          moveGear(s, kind, g, di, log)
          pairing[kind] = g
        }
      })
      fixed.set(m, pairing)
    }
    s.divs[di].fixed = fixed
    refresh(M, s, di, log, true)
  }
  if (live(s).length > M.maxDivs) {
    // More than allowed (the allowance shrank): the weakest go.
    const ds = live(s).sort((a, b) => s.divs[a].atk + s.divs[a].def - (s.divs[b].atk + s.divs[b].def))
    while (live(s).length > M.maxDivs) dissolve(s, ds.shift()!, log)
  }
  return s
}

/** The old deck's greedy construction, with a short budget, as one more place to start from. */
function greedyState(M: Model, input: SearchInput, budgetMs: number): State | null {
  const opt: OptimizeInput = {
    pool: input.pool,
    missions: input.missions,
    market: input.market,
    forgeLevel: input.forgeLevel,
    slotsFree: input.slotsFree,
    maxDivisions: input.maxDivisions,
    existing: input.existing,
    alignMove: input.alignMove,
    anchors: input.anchors
  }
  let plan
  try {
    plan = optimizeArmy(opt, undefined, budgetMs)
  } catch {
    return null
  }
  const s = emptyState(M)
  const ix = indexes(M)
  const log: Undo[] = []
  for (const d of plan.divisions) {
    const b = d.plan.bundle
    const w = ix.w.get(b.warlord.key)
    if (w === undefined || live(s).length >= M.maxDivs) continue
    const di = openDiv(s, w, log)
    for (const c of b.mercs) {
      const m = ix.m.get(c.key)
      if (m !== undefined && s.mAt[m] < 0 && s.divs[di].mercs.length < M.warlords[w].slots) moveMerc(s, m, di, log)
    }
    GK.forEach((k, kind) => {
      for (const c of b.gear[k]) {
        const g = ix.g[kind].get(c.key)
        if (g !== undefined && s.gAt[kind][g] < 0 && s.divs[di].gear[kind].length < s.divs[di].mercs.length && s.used[kind] < M.caps[kind])
          moveGear(s, kind, g, di, log)
      }
    })
    refresh(M, s, di, log)
  }
  return s
}

/** The cards of `pool` not yet used. */
function leftover(pool: Record<Kind, AssetRef[]>, used: Set<string>): Record<Kind, AssetRef[]> {
  return {
    warlord: pool.warlord.filter((a) => !used.has(a.assetId)),
    mercenary: pool.mercenary.filter((a) => !used.has(a.assetId)),
    weapon: pool.weapon.filter((a) => !used.has(a.assetId)),
    supply: pool.supply.filter((a) => !used.has(a.assetId)),
    creature: pool.creature.filter((a) => !used.has(a.assetId)),
    lavalux: pool.lavalux.filter((a) => !used.has(a.assetId))
  }
}

type Packed = NonNullable<ReturnType<typeof packDivisions>>

/** Puts packed divisions into the state; returns how many went in. */
function place(M: Model, s: State, plans: Packed, used: Set<string>, slots: Record<SlotKind, number>): number {
  const ix = indexes(M)
  const log: Undo[] = []
  let n = 0
  for (const pl of plans) {
    const b = pl.bundle
    const w = ix.w.get(b.warlord.key)
    if (w === undefined || s.wAt[w] >= 0 || live(s).length >= M.maxDivs) continue
    const di = openDiv(s, w, log)
    used.add(b.warlord.key)
    for (const c of b.mercs) {
      const m = ix.m.get(c.key)
      if (m !== undefined && s.mAt[m] < 0 && s.divs[di].mercs.length < M.warlords[w].slots) {
        moveMerc(s, m, di, log)
        used.add(c.key)
      }
    }
    GK.forEach((k, kind) => {
      for (const c of b.gear[k]) {
        const g = ix.g[kind].get(c.key)
        if (g !== undefined && s.gAt[kind][g] < 0 && s.divs[di].gear[kind].length < s.divs[di].mercs.length && s.used[kind] < M.caps[kind]) {
          moveGear(s, kind, g, di, log)
          used.add(c.key)
        }
      }
    })
    refresh(M, s, di, log)
    n++
  }
  for (const k of ['weapon', 'supply', 'lavalux'] as SlotKind[]) slots[k] = Math.max(0, slots[k] - plans.reduce((t, pl) => t + pl.bundle.gear[k].length, 0))
  return n
}

/** The most divisions of a mission the cards can field at once, as packed; null when not even one. */
function packMost(input: SearchInput, pool: Record<Kind, AssetRef[]>, mis: Mis, slots: Record<SlotKind, number>, most: number): Packed | null {
  // Not even one: done. Otherwise the largest count that packs, by halving (more is harder than fewer).
  let plans = packDivisions(pool, mis.m, 1, slots, input.forgeLevel)
  if (!plans) return null
  let lo = 1
  let hi = Math.max(1, Math.min(most, pool.warlord.length))
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const next = packDivisions(pool, mis.m, mid, slots, input.forgeLevel)
    if (next) {
      plans = next
      lo = mid
    } else hi = mid - 1
  }
  return plans
}

/**
 * Count first: for every mission, how many divisions of it the cards left can field at once and what
 * they earn together; the best such batch goes in, then the next from what is left, until the
 * allowance, the cards or the time run out.
 */
function fillGreedy(M: Model, input: SearchInput, s: State, used: Set<string>, slots: Record<SlotKind, number>, deadline: number, from: Mis[] = M.missions, rounds = 8) {
  for (let round = 0; round < rounds && live(s).length < M.maxDivs && Date.now() < deadline; round++) {
    const pool = leftover(input.pool, used)
    const left = M.maxDivs - live(s).length
    let best: { plans: Packed; value: number } | null = null
    for (const mis of from) {
      const plans = packMost(input, pool, mis, slots, left)
      if (!plans) continue
      const value = plans.reduce((v, pl) => v + rate(mis, pl.bundle.move), 0)
      if (!best || value > best.value) best = { plans, value }
    }
    if (!best || !place(M, s, best.plans, used, slots)) break
  }
}

export interface Tried {
  mission: MissionEconomics
  count: number
  perHour: number
}

/** Whether a division stands and meets the mission it is on. */
const meetsDiv = (M: Model, d: Div) => d.k >= 0 && d.mercs.length > 0 && d.atk >= M.missions[d.k].minAtk && d.def >= M.missions[d.k].minDef

/**
 * After an exchange between divisions i and j: where one now falls short of its mission and the
 * other still meets it, the other's strongest creature (no slot needed) or weapon crosses over, if
 * that makes both good. A slow-for-quick swap on a tight division almost always needs this; on its
 * own it fails nine times in ten.
 */
function compensate(M: Model, s: State, i: number, j: number, log: Undo[]) {
  for (const [need, giver] of [
    [i, j],
    [j, i]
  ] as const) {
    const N = s.divs[need]
    const G = s.divs[giver]
    if (meetsDiv(M, N) || !meetsDiv(M, G)) continue
    for (const kind of [2, 0]) {
      if (N.gear[kind].length >= N.mercs.length || !G.gear[kind].length) continue
      const list = [...G.gear[kind]].sort((a, b) => M.gear[kind][b].atk + M.gear[kind][b].def - (M.gear[kind][a].atk + M.gear[kind][a].def) || a - b)
      const mark = log.length
      moveGear(s, kind, list[0], need, log)
      evalDiv(M, N)
      evalDiv(M, G)
      if (meetsDiv(M, N) && meetsDiv(M, G)) break
      undoTo(log, mark)
      evalDiv(M, N)
      evalDiv(M, G)
    }
  }
}

/** How far a division falls short of a mission, as a share of what it asks (0 when it meets it). */
function shortOf(d: Div, mis: Mis): number {
  if (!d.mercs.length) return 1
  return (mis.minAtk ? Math.max(0, mis.minAtk - d.atk) / mis.minAtk : 0) + (mis.minDef ? Math.max(0, mis.minDef - d.def) / mis.minDef : 0)
}

/**
 * Brings the divisions `dis` up to `mis`, if it can: first greedily (a card from the pool, or from
 * the division with the most to spare, moved or swapped, or gear moved over, whenever that closes a
 * gap without the giver falling short), then, if that gets stuck, a short annealing run whose only
 * aim is to bring the total shortfall to nothing, with moves and swaps across the pool and these
 * divisions. Other divisions in the state are left alone. True when every one meets the mission.
 */
function repair(M: Model, s: State, dis: number[], mis: Mis, log: Undo[], r: Rng): boolean {
  const str = (m: number) => mis.wa * M.mercs[m].atk + mis.wd * M.mercs[m].def
  const gearStr = (kind: number, g: number) => {
    const c = M.gear[kind][g]
    return kind === L ? c.am + c.dm : mis.wa * c.atk + mis.wd * c.def + c.red * 0.01
  }
  const room = (di: number) => M.warlords[s.divs[di].w].slots - s.divs[di].mercs.length
  const short = (di: number) => shortOf(s.divs[di], mis)
  const surplus = (di: number) => {
    const d = s.divs[di]
    return (mis.minAtk ? (d.atk - mis.minAtk) / mis.minAtk : 0) + (mis.minDef ? (d.def - mis.minDef) / mis.minDef : 0)
  }
  const meets = (di: number) => short(di) === 0
  const own = new Set(dis)
  for (const di of dis) {
    s.divs[di].k = M.missions.indexOf(mis)
    evalDiv(M, s.divs[di])
  }
  /** Tries a change; keeps it only when `need` gets closer without the giver failing. */
  const attempt = (need: number, giver: number | null, change: () => void): boolean => {
    const before = short(need)
    const mark = log.length
    change()
    shedGear(s, need, log)
    if (giver !== null) shedGear(s, giver, log)
    evalDiv(M, s.divs[need])
    if (giver !== null) evalDiv(M, s.divs[giver])
    if (short(need) < before - 1e-12 && (giver === null || meets(giver))) return true
    undoTo(log, mark)
    evalDiv(M, s.divs[need])
    if (giver !== null) evalDiv(M, s.divs[giver])
    return false
  }
  for (let round = 0; round < 400; round++) {
    const need = dis.reduce((a, b) => (short(a) >= short(b) ? a : b))
    if (meets(need)) break
    let fixed = false
    if (room(need) > 0) {
      const pool = M.mercs.map((_, i) => i).filter((m) => s.mAt[m] < 0).sort((a, b) => str(b) - str(a) || a - b)
      for (const m of pool.slice(0, 20)) if ((fixed = attempt(need, null, () => moveMerc(s, m, need, log)))) break
    }
    for (const kind of [0, 2, L, S]) {
      if (fixed) break
      if (s.divs[need].gear[kind].length >= s.divs[need].mercs.length || s.used[kind] >= M.caps[kind]) continue
      const pool = M.gear[kind].map((_, i) => i).filter((g) => s.gAt[kind][g] < 0).sort((a, b) => gearStr(kind, b) - gearStr(kind, a) || a - b)
      for (const g of pool.slice(0, 10)) if ((fixed = attempt(need, null, () => moveGear(s, kind, g, need, log)))) break
    }
    const givers = dis.filter((di) => di !== need && surplus(di) > 0).sort((a, b) => surplus(b) - surplus(a))
    for (const giver of givers) {
      if (fixed) break
      const gm = [...s.divs[giver].mercs].sort((a, b) => str(a) - str(b) || a - b)
      if (room(need) > 0) for (const m of gm) if ((fixed = attempt(need, giver, () => moveMerc(s, m, need, log)))) break
      if (fixed) break
      for (const kind of [0, 2, L, S]) {
        if (fixed) break
        if (s.divs[need].gear[kind].length >= s.divs[need].mercs.length) continue
        const gg = [...s.divs[giver].gear[kind]].sort((a, b) => gearStr(kind, b) - gearStr(kind, a) || a - b)
        for (const g of gg) if ((fixed = attempt(need, giver, () => moveGear(s, kind, g, need, log)))) break
      }
      if (fixed) break
      const nm = [...s.divs[need].mercs].sort((a, b) => str(a) - str(b) || a - b)
      for (const strong of [...gm].reverse().slice(0, 12)) {
        if (fixed) break
        for (const weak of nm.slice(0, 12)) {
          if (str(strong) <= str(weak)) continue
          if (
            (fixed = attempt(need, giver, () => {
              moveMerc(s, strong, need, log)
              moveMerc(s, weak, giver, log)
            }))
          )
            break
        }
      }
    }
    if (!fixed) break
  }
  if (dis.every(meets)) return true

  // Stuck: a search over the shortfall alone. Any card may move or swap between the pool and these
  // divisions; a change is kept when the total shortfall drops, and sometimes when it rises a little.
  const total = () => dis.reduce((n, di) => n + short(di), 0)
  let cur = total()
  const STEPS = 40_000
  const t0 = 0.02
  const t1 = 0.0002
  const poolMercs = () => M.mercs.map((_, i) => i).filter((m) => s.mAt[m] < 0)
  for (let step = 0; step < STEPS && cur > 0; step++) {
    const mark = log.length
    const touched: number[] = []
    const x = r()
    const di = dis[Math.floor(r() * dis.length)]
    if (x < 0.3) {
      // A mercenary from the pool, or from another of these divisions, into di.
      if (room(di) <= 0) continue
      const from = r() < 0.5 ? -1 : dis[Math.floor(r() * dis.length)]
      const cands = from < 0 ? poolMercs() : s.divs[from].mercs
      if (!cands.length || from === di) continue
      const m = cands[Math.floor(r() * cands.length)]
      moveMerc(s, m, di, log)
      touched.push(di)
      if (from >= 0) touched.push(from)
    } else if (x < 0.6) {
      // Two mercenaries swap: di's with the pool's or another division's.
      const dj = r() < 0.5 ? -1 : dis[Math.floor(r() * dis.length)]
      const a = s.divs[di].mercs
      const b = dj < 0 ? poolMercs() : s.divs[dj].mercs
      if (!a.length || !b.length || dj === di) continue
      const ma = a[Math.floor(r() * a.length)]
      const mb = b[Math.floor(r() * b.length)]
      moveMerc(s, ma, dj, log)
      moveMerc(s, mb, di, log)
      touched.push(di)
      if (dj >= 0) touched.push(dj)
    } else if (x < 0.8) {
      // Gear into di, from the pool or another of these divisions.
      const kind = [0, 2, L, S][Math.floor(r() * 4)]
      if (s.divs[di].gear[kind].length >= s.divs[di].mercs.length) continue
      const from = r() < 0.5 ? -1 : dis[Math.floor(r() * dis.length)]
      if (from === di) continue
      const cands = from < 0 ? M.gear[kind].map((_, i) => i).filter((g) => s.gAt[kind][g] < 0) : s.divs[from].gear[kind]
      if (!cands.length || (from < 0 && s.used[kind] >= M.caps[kind])) continue
      moveGear(s, kind, cands[Math.floor(r() * cands.length)], di, log)
      touched.push(di)
      if (from >= 0) touched.push(from)
    } else {
      // Two pieces of gear swap between di and another of these divisions.
      const kind = [0, 2, L, S][Math.floor(r() * 4)]
      const dj = dis[Math.floor(r() * dis.length)]
      const a = s.divs[di].gear[kind]
      const b = s.divs[dj].gear[kind]
      if (dj === di || !a.length || !b.length) continue
      const ga = a[Math.floor(r() * a.length)]
      const gb = b[Math.floor(r() * b.length)]
      moveGear(s, kind, ga, dj, log)
      moveGear(s, kind, gb, di, log)
      touched.push(di, dj)
    }
    for (const t of touched) {
      shedGear(s, t, log)
      evalDiv(M, s.divs[t])
    }
    const next = total()
    const d = cur - next
    if (d >= 0 || r() < Math.exp(d / (t0 * Math.pow(t1 / t0, step / STEPS)))) cur = next
    else {
      undoTo(log, mark)
      for (const t of touched) evalDiv(M, s.divs[t])
    }
  }
  return dis.every(meets) && [...own].every(meets)
}

/**
 * `n` divisions that all meet one mission, dealt evenly and then repaired: the n warlords with the
 * most slots, the mercenaries dealt strongest-first back and forth across the divisions, the gear
 * likewise, then `repair`. Null when it cannot. The result has only these divisions; the rest of
 * the cards are in the pool.
 */
function balancedPack(M: Model, mis: Mis, n: number, r: Rng): State | null {
  const s = emptyState(M)
  const log: Undo[] = []
  const ws = M.warlords.map((_, i) => i).sort((a, b) => M.warlords[b].slots - M.warlords[a].slots || a - b).slice(0, n)
  if (ws.length < n || n > M.maxDivs) return null
  const dis = ws.map((w) => openDiv(s, w, log))
  const str = (m: number) => mis.wa * M.mercs[m].atk + mis.wd * M.mercs[m].def
  const gearStr = (kind: number, g: number) => {
    const c = M.gear[kind][g]
    return kind === L ? c.am + c.dm : mis.wa * c.atk + mis.wd * c.def + c.red * 0.01
  }
  const room = (di: number) => M.warlords[s.divs[di].w].slots - s.divs[di].mercs.length
  const mercs = M.mercs.map((_, i) => i).sort((a, b) => str(b) - str(a) || a - b)
  let turn = 0
  let forward = true
  for (const m of mercs) {
    let placed = false
    for (let tries = 0; tries < n && !placed; tries++) {
      const di = dis[turn]
      if (room(di) > 0) {
        moveMerc(s, m, di, log)
        placed = true
      }
      turn = forward ? turn + 1 : turn - 1
      if (turn >= n || turn < 0) {
        forward = !forward
        turn = forward ? 0 : n - 1
      }
    }
    if (!placed) break
  }
  for (const kind of [0, 2, L, S]) {
    const items = M.gear[kind].map((_, i) => i).sort((a, b) => gearStr(kind, b) - gearStr(kind, a) || a - b)
    let t = 0
    for (const g of items) {
      if (s.used[kind] >= M.caps[kind]) break
      let placed = false
      for (let tries = 0; tries < n && !placed; tries++) {
        const di = dis[t]
        t = (t + 1) % n
        if (s.divs[di].gear[kind].length < s.divs[di].mercs.length) {
          moveGear(s, kind, g, di, log)
          placed = true
        }
      }
      if (!placed) break
    }
  }
  if (!repair(M, s, dis, mis, log, r)) return null
  for (const di of dis) refresh(M, s, di, log)
  return s
}

/**
 * `n` divisions of one mission grown out of the army as it stands: the n existing divisions nearest
 * to meeting it are kept (more are opened with spare warlords when there are fewer), everything
 * else goes to the pool, and `repair` closes the gaps. Where the player's own arrangement is close,
 * a card or two from the pool is all it takes; a fresh deal might never find that. Null when it cannot.
 */
function packFromAsIs(M: Model, asIs: State, mis: Mis, n: number, r: Rng): State | null {
  if (n > M.maxDivs) return null
  const s = cloneState(asIs)
  const log: Undo[] = []
  const ranked = live(s).sort((a, b) => shortOf(s.divs[a], mis) - shortOf(s.divs[b], mis))
  const keep = ranked.slice(0, n)
  for (const di of ranked.slice(n)) dissolve(s, di, log)
  while (keep.length < n) {
    const w = M.warlords.findIndex((_, i) => s.wAt[i] < 0)
    if (w < 0) return null
    keep.push(openDiv(s, w, log))
  }
  if (!repair(M, s, keep, mis, log, r)) return null
  for (const di of keep) refresh(M, s, di, log)
  return s
}

/**
 * `n` divisions of one mission dealt for equal move cost. The mercenaries go out in order of worth
 * per point of move, each to the division with the lowest move so far that still falls short, so
 * the divisions grow together and none takes all the quick cards; supplies go to the slowest,
 * attack gear and Lava Lux to the one furthest short; `repair` closes what is left. This is the
 * shape a player reaches by hand (five at 117, 117, 117, 117, 110), which packing tightest-first
 * never gives (0, 0, 181, 342, 392 from the same cards). Null when it cannot be done.
 */
function dealPack(M: Model, mis: Mis, n: number, r: Rng): State | null {
  const s = emptyState(M)
  const log: Undo[] = []
  const ws = M.warlords.map((_, i) => i).sort((a, b) => M.warlords[b].slots - M.warlords[a].slots || a - b).slice(0, n)
  if (ws.length < n || n > M.maxDivs) return null
  const dis = ws.map((w) => openDiv(s, w, log))
  const k = M.missions.indexOf(mis)
  const str = (m: number) => mis.wa * M.mercs[m].atk + mis.wd * M.mercs[m].def
  const gearStr = (kind: number, g: number) => {
    const c = M.gear[kind][g]
    return kind === L ? c.am + c.dm : mis.wa * c.atk + mis.wd * c.def + c.red * 0.01
  }
  const room = (di: number) => M.warlords[s.divs[di].w].slots - s.divs[di].mercs.length
  const short = (di: number) => shortOf(s.divs[di], mis)
  for (const di of dis) {
    s.divs[di].k = k
    evalDiv(M, s.divs[di])
  }
  const mercs = M.mercs.map((_, i) => i).sort((a, b) => str(b) / (8 + M.mercs[b].move) - str(a) / (8 + M.mercs[a].move) || a - b)
  for (const m of mercs) {
    const open = dis.filter((di) => room(di) > 0 && short(di) > 0)
    if (!open.length) break
    const di = open.reduce((a, b) => (s.divs[a].move < s.divs[b].move || (s.divs[a].move === s.divs[b].move && short(a) >= short(b)) ? a : b))
    moveMerc(s, m, di, log)
    evalDiv(M, s.divs[di])
  }
  for (const kind of [S, 0, 2, L]) {
    const items = M.gear[kind].map((_, i) => i).sort((a, b) => gearStr(kind, b) - gearStr(kind, a) || a - b)
    for (const g of items) {
      if (s.used[kind] >= M.caps[kind]) break
      const open = dis.filter((di) => s.divs[di].gear[kind].length < s.divs[di].mercs.length)
      if (!open.length) break
      const di =
        kind === S
          ? open.reduce((a, b) => (s.divs[a].move >= s.divs[b].move ? a : b))
          : open.reduce((a, b) => (short(a) > short(b) || (short(a) === short(b) && s.divs[a].move >= s.divs[b].move) ? a : b))
      moveGear(s, kind, g, di, log)
      evalDiv(M, s.divs[di])
    }
  }
  if (!repair(M, s, dis, mis, log, r)) return null
  for (const di of dis) refresh(M, s, di, log)
  return s
}

/**
 * Each of the divisions brought to the lowest move cost it can have while still meeting its
 * mission: its slowest cards leave for the pool and Lava Lux that adds move comes off, as long as
 * the mission is still met and the move really falls. The gear is dealt again at every step.
 */
function trimMoves(M: Model, s: State, dis: number[], log: Undo[]) {
  for (const di of dis) {
    const d = s.divs[di]
    if (d.w < 0 || d.k < 0) continue
    const mis = M.missions[d.k]
    const meets = () => d.mercs.length > 0 && d.atk >= mis.minAtk && d.def >= mis.minDef
    for (let guard = 0; guard < 200; guard++) {
      let changed = false
      const before = d.move
      if (before === 0) break
      const order = [...d.mercs].sort((a, b) => M.mercs[b].move - M.mercs[a].move || a - b)
      for (const m of order) {
        if (d.mercs.length <= 1) break
        const mark = log.length
        moveMerc(s, m, -1, log)
        shedGear(s, di, log)
        evalDiv(M, d)
        if (meets() && d.move < before) {
          changed = true
          break
        }
        undoTo(log, mark)
        evalDiv(M, d)
      }
      if (!changed)
        for (const g of [...d.gear[L]]) {
          const mark = log.length
          moveGear(s, L, g, -1, log)
          evalDiv(M, d)
          if (meets() && d.move < before) {
            changed = true
            break
          }
          undoTo(log, mark)
          evalDiv(M, d)
        }
      if (!changed) break
    }
    refresh(M, s, di, log)
  }
}

/**
 * Evens out the move costs of the divisions on missions of one base length: the slowest hands a
 * card to the quickest (or they swap one, or a supply changes hands) whenever that narrows the gap
 * and both still meet their missions. Repeated until the gap is within the tolerance or nothing
 * helps. Five divisions at a hundred move earn more than four at none, and the player asked for
 * them to match: trimming alone would never get there.
 */
function balanceGroups(M: Model, s: State, log: Undo[]) {
  const groups = new Map<number, number[]>()
  for (const di of live(s)) {
    const d = s.divs[di]
    if (d.k < 0) continue
    const base = M.missions[d.k].base
    groups.set(base, [...(groups.get(base) ?? []), di])
  }
  const meets = (di: number) => {
    const d = s.divs[di]
    const mis = M.missions[d.k]
    return d.mercs.length > 0 && d.atk >= mis.minAtk && d.def >= mis.minDef
  }
  const room = (di: number) => M.warlords[s.divs[di].w].slots - s.divs[di].mercs.length
  for (const dis of groups.values()) {
    if (dis.length < 2) continue
    for (let round = 0; round < 120; round++) {
      const moves = dis.map((di) => s.divs[di].move)
      const slow = dis[moves.indexOf(Math.max(...moves))]
      const fast = dis[moves.indexOf(Math.min(...moves))]
      const gap = s.divs[slow].move - s.divs[fast].move
      if (gap <= MATCH_TOLERANCE || slow === fast) break
      const S_ = s.divs[slow]
      const F_ = s.divs[fast]
      const gapAfter = () => {
        const ms = dis.map((di) => s.divs[di].move)
        return Math.max(...ms) - Math.min(...ms)
      }
      let best: { gap: number; apply: () => void } | null = null
      const trial = (apply: () => void) => {
        const mark = log.length
        apply()
        shedGear(s, slow, log)
        shedGear(s, fast, log)
        evalDiv(M, S_)
        evalDiv(M, F_)
        const g = gapAfter()
        if (meets(slow) && meets(fast) && g < gap - 1e-9 && (!best || g < best.gap)) best = { gap: g, apply }
        undoTo(log, mark)
        evalDiv(M, S_)
        evalDiv(M, F_)
      }
      const slowMercs = [...S_.mercs].sort((a, b) => M.mercs[b].move - M.mercs[a].move || a - b).slice(0, 14)
      const fastMercs = [...F_.mercs].sort((a, b) => M.mercs[a].move - M.mercs[b].move || a - b).slice(0, 14)
      // A card over, when there is room.
      if (room(fast) > 0) for (const m of slowMercs) trial(() => moveMerc(s, m, fast, log))
      // A swap: the slowest's slow card for the quickest's quick card.
      for (const a of slowMercs) for (const b of fastMercs) if (M.mercs[a].move > M.mercs[b].move) trial(() => (moveMerc(s, a, fast, log), moveMerc(s, b, slow, log)))
      // Attack without move: a weapon or creature from the quickest to the slowest, and with the spare
      // attack that gives, one of the slowest's slow cards leaves, to the quickest or to the pool.
      for (const kind of [0, 2]) {
        if (S_.gear[kind].length >= S_.mercs.length) continue
        const gear = [...F_.gear[kind]].sort((a, b) => M.gear[kind][b].atk + M.gear[kind][b].def - (M.gear[kind][a].atk + M.gear[kind][a].def) || a - b).slice(0, 6)
        for (const g of gear)
          for (const m of slowMercs) {
            trial(() => (moveGear(s, kind, g, slow, log), moveMerc(s, m, -1, log)))
            if (room(fast) > 0) trial(() => (moveGear(s, kind, g, slow, log), moveMerc(s, m, fast, log)))
          }
      }
      // A supply from the quickest to the slowest, or swapped for a weaker one.
      if (S_.gear[S].length < S_.mercs.length) for (const g of [...F_.gear[S]]) trial(() => moveGear(s, S, g, slow, log))
      for (const a of [...S_.gear[S]]) for (const b of [...F_.gear[S]]) if (M.gear[S][b].red > M.gear[S][a].red) trial(() => (moveGear(s, S, a, fast, log), moveGear(s, S, b, slow, log)))
      if (!best) break
      const chosen: { gap: number; apply: () => void } = best
      chosen.apply()
      shedGear(s, slow, log)
      shedGear(s, fast, log)
      evalDiv(M, S_)
      evalDiv(M, F_)
    }
    for (const di of dis) refresh(M, s, di, log)
  }
}

/**
 * Every exchange between two divisions of one mission length, tried outright and judged by the
 * score: a slower card of one for a quicker card of the other, a card over, a supply over or swapped
 * for a stronger one, each with attack sent across when a side would otherwise fall short. The one
 * that raises the score most is kept; again until none does. balanceGroups looks only at the
 * slowest and the quickest and only at the gap; this weighs income and spread together over every
 * pair. Balancing only (the model is frozen).
 */
function exchangePass(M: Model, s: State, deadline: number, rounds = 80) {
  const log: Undo[] = []
  const groups = new Map<number, number[]>()
  for (const di of live(s)) {
    const d = s.divs[di]
    if (d.k >= 0) groups.set(M.missions[d.k].base, [...(groups.get(M.missions[d.k].base) ?? []), di])
  }
  const rm = (di: number) => M.warlords[s.divs[di].w].slots - s.divs[di].mercs.length
  for (const dis of groups.values()) {
    if (dis.length < 2) continue
    for (let round = 0; round < rounds && Date.now() < deadline; round++) {
      let bestV = objective(M, s).real
      let snap: State | null = null
      const trial = (i: number, j: number, apply: () => void) => {
        const mark = log.length
        apply()
        // refresh logs the values from before, so the undo below leaves true stats behind.
        for (const di of [i, j]) {
          shedGear(s, di, log)
          refresh(M, s, di, log)
        }
        compensate(M, s, i, j, log)
        for (const di of [i, j]) refresh(M, s, di, log)
        const v = objective(M, s).real
        if (v > bestV + 1e-9) {
          bestV = v
          snap = cloneState(s)
        }
        undoTo(log, mark)
        for (const di of [i, j]) evalDiv(M, s.divs[di])
      }
      // Warlords: a spare one with more places or a bigger cut for a division, or two divisions
      // trading theirs. A full division cannot take a card; a bigger cut takes move off outright.
      const spare = M.warlords.map((_, w) => w).filter((w) => s.wAt[w] < 0)
      for (const i of dis) {
        for (const w of spare) if (M.warlords[w].slots >= s.divs[i].mercs.length) trial(i, i, () => setWarlord(s, i, w, log))
        for (const j of dis) {
          if (j <= i) continue
          const wi = s.divs[i].w
          const wj = s.divs[j].w
          if (M.warlords[wj].slots < s.divs[i].mercs.length || M.warlords[wi].slots < s.divs[j].mercs.length) continue
          trial(i, j, () => {
            setWarlord(s, j, -1, log)
            setWarlord(s, i, wj, log)
            setWarlord(s, j, wi, log)
          })
        }
      }
      for (const i of dis)
        for (const j of dis) {
          if (i === j || s.divs[i].move <= s.divs[j].move) continue
          // Every unit of a division this size; the slowest and quickest dozen of a bigger one.
          const A = [...s.divs[i].mercs].sort((a, b) => M.mercs[b].move - M.mercs[a].move || a - b).slice(0, s.divs[i].mercs.length <= 24 ? 24 : 12)
          const B = [...s.divs[j].mercs].sort((a, b) => M.mercs[a].move - M.mercs[b].move || a - b).slice(0, s.divs[j].mercs.length <= 24 ? 24 : 12)
          for (const a of A) for (const b of B) if (M.mercs[a].move > M.mercs[b].move) trial(i, j, () => (moveMerc(s, a, j, log), moveMerc(s, b, i, log)))
          // The quick division's strongest units, each for as many of the slow one's weak units as it can spare.
          const ranked = [...s.divs[j].mercs].sort((a, b) => M.mercs[b].atk + M.mercs[b].def - (M.mercs[a].atk + M.mercs[a].def) || a - b)
          const picks = new Set<number>(ranked.slice(0, 4))
          for (let k = 0; k < 8 && ranked.length; k++) picks.add(ranked[Math.min(ranked.length - 1, Math.floor(((k + 0.5) * ranked.length) / 8))])
          for (const b of picks) {
            trial(i, j, () => manyForOne(M, s, i, j, b, log, true))
            trial(i, j, () => manyForOne(M, s, i, j, b, log, false))
          }
          if (rm(j) > 0) for (const a of A) trial(i, j, () => moveMerc(s, a, j, log))
          if (s.divs[i].gear[S].length < s.divs[i].mercs.length) for (const g of [...s.divs[j].gear[S]]) trial(i, j, () => moveGear(s, S, g, i, log))
          for (const a of [...s.divs[i].gear[S]]) for (const b of [...s.divs[j].gear[S]]) if (M.gear[S][b].red > M.gear[S][a].red) trial(i, j, () => (moveGear(s, S, a, j, log), moveGear(s, S, b, i, log)))
        }
      if (!snap) break
      Object.assign(s, snap)
      log.length = 0
    }
  }
}

/**
 * Every exchange that can lower a division's move cost, tried outright and judged by the score,
 * with every other division and with the cards nobody fields (the reserve, and the wallet when it
 * is in play) as the other side: a mercenary swapped, sent over or taken in; any kind of gear
 * swapped, sent over or taken in; each time with attack sent back across when a side would
 * otherwise fall short (compensate). The best one is kept, then again until none helps. The
 * divisions and their missions stay as they are (the model should be frozen), so it serves the
 * best answer (income only) as well as the balanced one. A single change seldom helps a tight
 * army; an exchange with its compensation often does.
 */
function exchangeAll(M: Model, s: State, deadline = Infinity, maxRounds = 40): number {
  const log: Undo[] = []
  let made = 0
  const room = (di: number) => M.warlords[s.divs[di].w].slots - s.divs[di].mercs.length
  // The likeliest cards first, a bounded number of each: the slowest of the division that should get
  // quicker, the quickest of the other side.
  const LIST = 16
  const slowest = (list: number[]) => [...list].sort((a, b) => M.mercs[b].move - M.mercs[a].move || a - b).slice(0, LIST)
  const quickest = (list: number[]) => [...list].sort((a, b) => M.mercs[a].move - M.mercs[b].move || a - b).slice(0, LIST)
  for (let round = 0; round < maxRounds && Date.now() < deadline; round++) {
    let bestV = objective(M, s).real
    if (bestV < -1e8) return made
    let snap: State | null = null
    const trial = (i: number, j: number, apply: () => boolean) => {
      const mark = log.length
      if (apply()) {
        const touched = j >= 0 ? [i, j] : [i]
        for (const di of touched) {
          shedGear(s, di, log)
          refresh(M, s, di, log)
        }
        if (j >= 0) {
          compensate(M, s, i, j, log)
          for (const di of touched) refresh(M, s, di, log)
        }
        const v = objective(M, s).real
        if (v > bestV + 1e-9) {
          bestV = v
          snap = cloneState(s)
        }
      }
      undoTo(log, mark)
      evalDiv(M, s.divs[i])
      if (j >= 0) evalDiv(M, s.divs[j])
    }
    const divs = live(s).filter((di) => s.divs[di].k >= 0)
    const poolMercs = quickest(M.mercs.map((_, m) => m).filter((m) => s.mAt[m] < 0))
    const poolGear = M.gear.map((list, kind) => list.map((_, g) => g).filter((g) => s.gAt[kind][g] < 0))
    for (const i of divs) {
      if (s.divs[i].move <= 0 || Date.now() > deadline) continue
      const A = slowest(s.divs[i].mercs)
      // With another division.
      for (const j of divs) {
        if (j === i || Date.now() > deadline) continue
        const B = quickest(s.divs[j].mercs)
        for (const a of A) for (const b of B) trial(i, j, () => (moveMerc(s, a, j, log), moveMerc(s, b, i, log), true))
        if (room(j) > 0) for (const a of A) trial(i, j, () => (moveMerc(s, a, j, log), true))
        if (room(i) > 0) for (const b of B) trial(i, j, () => (moveMerc(s, b, i, log), true))
        for (let kind = 0; kind < 4; kind++) {
          const Gi = [...s.divs[i].gear[kind]]
          const Gj = [...s.divs[j].gear[kind]]
          for (const a of Gi) for (const b of Gj) trial(i, j, () => (moveGear(s, kind, a, j, log), moveGear(s, kind, b, i, log), true))
          for (const a of Gi) trial(i, j, () => (moveGear(s, kind, a, j, log), true))
          for (const b of Gj) trial(i, j, () => (moveGear(s, kind, b, i, log), true))
        }
      }
      // With the cards nobody fields.
      for (const a of A) {
        trial(i, -1, () => (moveMerc(s, a, -1, log), true))
        for (const b of poolMercs) trial(i, -1, () => (moveMerc(s, a, -1, log), moveMerc(s, b, i, log), true))
      }
      if (room(i) > 0) for (const b of poolMercs) trial(i, -1, () => (moveMerc(s, b, i, log), true))
      for (let kind = 0; kind < 4; kind++) {
        const Gi = [...s.divs[i].gear[kind]]
        for (const a of Gi) {
          trial(i, -1, () => (moveGear(s, kind, a, -1, log), true))
          for (const b of poolGear[kind]) trial(i, -1, () => (moveGear(s, kind, a, -1, log), moveGear(s, kind, b, i, log), true))
        }
        for (const b of poolGear[kind]) trial(i, -1, () => (s.used[kind] < M.caps[kind] ? (moveGear(s, kind, b, i, log), true) : false))
      }
    }
    if (!snap) break
    Object.assign(s, snap)
    log.length = 0
    made++
  }
  return made
}

/** Per mission length with two or more divisions (the ones out counted): their move costs and spread. */
function groupSpreads(M: Model, s: State): { base: number; moves: number[]; spread: number }[] {
  const groups = new Map<number, number[]>()
  for (const [base, move] of M.anchors) groups.set(base, [move])
  for (const di of live(s)) {
    const d = s.divs[di]
    if (d.k < 0) continue
    const base = M.missions[d.k].base
    const g = groups.get(base)
    if (g) g.push(d.move)
    else groups.set(base, [d.move])
  }
  return [...groups].filter(([, m]) => m.length > 1).map(([base, moves]) => ({ base, moves, spread: Math.max(...moves) - Math.min(...moves) }))
}

/**
 * One strong unit of the quick division for as many of the slow division's weak units as it can
 * spare: the slow one takes the strong unit (its gear is dealt again, so a Lava Lux lands on it),
 * then hands over its worst units by move per attack, each only while it still meets its mission,
 * until the quick one meets its mission again. A tight division cannot shed move one card at a
 * time (every card it has is needed for its attack), but it can shed many at once in exchange for
 * one strong card; this is the move that evens out a 0 / 600 split. Balancing only.
 */
function manyForOne(M: Model, s: State, slow: number, quick: number, b: number, log: Undo[], withGear: boolean): void {
  const S = s.divs[slow]
  const Q = s.divs[quick]
  if (S.mercs.length >= M.warlords[S.w].slots) return
  // The gear the unit carries where it is: a Lava Lux multiplies a strong unit's attack far more than
  // the weak unit it would be left on, so the attack is only conserved when it comes along.
  const carried: number[] = []
  if (withGear) {
    const picks: number[][] = []
    evalDiv(M, Q, undefined, picks)
    const at = Q.mercs.indexOf(b)
    for (let kind = 0; kind < 4; kind++) if (picks[kind] && picks[kind][at] >= 0) carried.push(kind * 1000 + picks[kind][at])
  }
  moveMerc(s, b, slow, log)
  for (const c of carried) {
    const kind = Math.floor(c / 1000)
    const g = c % 1000
    if (S.gear[kind].length < S.mercs.length) moveGear(s, kind, g, slow, log)
  }
  refresh(M, s, slow, log)
  refresh(M, s, quick, log)
  const cost = (m: number) => (M.mercs[m].move + 1) / (M.mercs[m].atk + M.mercs[m].def + 1)
  const order = S.mercs.filter((m) => m !== b).sort((x, y) => cost(y) - cost(x) || x - y)
  for (const u of order) {
    if (Q.mercs.length >= M.warlords[Q.w].slots) break
    const met = meetsDiv(M, Q)
    const gap = Math.abs(S.move - Q.move)
    const mark = log.length
    moveMerc(s, u, quick, log)
    refresh(M, s, slow, log)
    refresh(M, s, quick, log)
    // Until the quick division meets its mission, every card the slow one can spare goes; after
    // that, only while the two come closer.
    const keep = meetsDiv(M, S) && (!met || Math.abs(S.move - Q.move) < gap)
    if (!keep) {
      undoTo(log, mark)
      evalDiv(M, S)
      evalDiv(M, Q)
      if (met) break
    }
  }
}

/**
 * The most attack (or defense) every card in the model can make together, whatever the divisions:
 * the best weapons, supplies and creatures on the strongest units, the Lava Lux on the strongest
 * units once geared, each unit rounded down as the contract does. An upper bound, so when it is
 * barely above what the fielded divisions need, nothing can be evened out: there is no card to spare.
 */
function statBound(M: Model, stat: 'atk' | 'def'): number {
  const mult = stat === 'atk' ? 'am' : 'dm'
  const units = M.mercs.map((c) => c[stat]).sort((a, b) => b - a)
  const gear = (kind: number) => M.gear[kind].map((c) => c[stat]).sort((a, b) => b - a)
  const w = gear(0)
  const su = gear(1)
  const cr = gear(2)
  const geared = units.map((u, i) => u + (w[i] ?? 0) + (su[i] ?? 0) + (cr[i] ?? 0)).sort((a, b) => b - a)
  const lux = M.gear[L].map((c) => c[mult]).sort((a, b) => b - a)
  return geared.reduce((n, a, i) => n + Math.floor(a * (lux[i] ?? 1) + 1e-9), 0)
}

/** The arrangement as text, to tell two states apart. */
function signature(s: State): string {
  return live(s)
    .map((di) => {
      const d = s.divs[di]
      return `${d.w}:${d.k}:${[...d.mercs].sort((a, b) => a - b).join(',')}:${d.gear.map((g) => [...g].sort((a, b) => a - b).join(',')).join('|')}`
    })
    .sort()
    .join(';')
}

/** The cards a state has placed, by asset id. */
function placedIn(M: Model, s: State): Set<string> {
  const used = new Set<string>()
  for (const d of s.divs) {
    if (d.w < 0) continue
    used.add(M.warlords[d.w].ref.assetId)
    for (const m of d.mercs) used.add(M.mercs[m].ref.assetId)
    d.gear.forEach((list, kind) => list.forEach((g) => used.add(M.gear[kind][g].ref.assetId)))
  }
  return used
}

/**
 * The systematic part of the search. Every mission at every count: n divisions of mission k from
 * the whole army, the rest filled in around them, each a complete army scored for real; the random
 * search cannot promise to look at "five of the expensive mission", this does. Two packers try each
 * count (the tightest-first one and the balanced one), so a count is only given up when both fail
 * and the army does not already field that many. The missions that look most efficient, by TLM an
 * hour and by TLM an hour per hundred points of the attack or defense they ask for (whichever is
 * more), get the intense treatment: each count is also tried with every other efficient mission
 * filling the remainder first, and every candidate gets a short burst of annealing before it is
 * scored, so it is judged tuned rather than raw. Runs until done or until its share of the time is
 * used. Returns the candidate armies, best first, and a note per mission of the most divisions of
 * it that were fielded, with the best army total that gave.
 */
function coverage(
  M: Model,
  input: SearchInput,
  asIs: State,
  deadline: number,
  r: Rng,
  onStep?: (burstMoves: number) => void,
  onBetter?: (state: State, value: number) => void
): { states: State[]; tried: Tried[]; moves: number } {
  const states: { s: State; value: number }[] = []
  const tried = new Map<number, Tried>()
  const need = (m: Mis) => Math.max(m.minAtk, m.minDef, 1)
  // A rough idea of what each mission could be worth: how many divisions of it the cards' attack and
  // defense could make (gear included, nothing wasted), at the army's typical move per point.
  let totalAtk = 0
  let totalDef = 0
  let totalMove = 0
  for (const c of M.mercs) {
    totalAtk += c.atk
    totalDef += c.def
    totalMove += c.move
  }
  for (const kind of [0, 1, 2]) for (const c of M.gear[kind]) (totalAtk += c.atk), (totalDef += c.def)
  const estimate = (mis: Mis) =>
    Math.max(0, Math.min(mis.minAtk ? Math.floor(totalAtk / mis.minAtk) : Infinity, mis.minDef ? Math.floor(totalDef / mis.minDef) : Infinity, M.maxDivs, M.warlords.length))
  const guessMove = (mis: Mis) =>
    0.7 * Math.max(totalAtk ? (mis.minAtk * totalMove) / totalAtk : 0, totalDef ? (mis.minDef * totalMove) / totalDef : 0)
  const promise = (mis: Mis) => Math.max(1, estimate(mis)) * rate(mis, guessMove(mis))
  const byPromise = [...M.missions].sort((a, b) => promise(b) - promise(a))
  const byEfficiency = [...M.missions].sort((a, b) => rate(b, 0) / need(b) - rate(a, 0) / need(a))
  const focus = new Set<Mis>([...byPromise.slice(0, 5), ...byEfficiency.slice(0, 5)])
  let bestSoFar = -Infinity
  let burstMoves = 0
  // A short, cool burst: enough to settle the obvious (move costs, gear), not to rebuild.
  const BURST = 6000
  const t0 = temperature(M, emptyState(M), r) / 4 || 1
  const note = (mis: Mis, n: number, value: number) => {
    const was = tried.get(mis.m.id)
    if (!was) tried.set(mis.m.id, { mission: mis.m, count: n, perHour: value })
    else {
      was.count = Math.max(was.count, n)
      was.perHour = Math.max(was.perHour, value)
    }
  }
  // What the army fields already is the floor: never claim fewer than that.
  const asIsValue = objective(M, asIs).real
  for (const mis of M.missions) {
    const have = asIs.divs.filter((d) => d.w >= 0 && d.mercs.length > 0 && d.atk >= mis.minAtk && d.def >= mis.minDef).length
    if (have) note(mis, have, asIsValue)
  }
  const score = (st: State, mis: Mis, n: number) => {
    const b: Best = { state: cloneState(st), real: objective(M, st).real }
    burstMoves += anneal(M, st, t0, t0 / 50, r, b, deadline, undefined, BURST)
    states.push({ s: b.state, value: b.real })
    note(mis, n, b.real)
    if (b.real > bestSoFar + 1e-9) {
      bestSoFar = b.real
      onBetter?.(b.state, b.real)
    }
    onStep?.(burstMoves)
  }
  /** Scores a candidate; with move-matching, its matched form as well. */
  const consider = (st: State, mis: Mis, n: number) => score(st, mis, n)
  /** The remainder of `base` filled: plainly, and (for an efficient mission) each partner first. */
  // Counted work: the rest of an army comes from the most promising few missions, and an efficient
  // mission tries its first few partners, in a fixed order; no clock decides how much gets done.
  const eff = input.effort
  const fillFrom = eff ? byPromise.slice(0, eff.fill) : M.missions
  const fillRounds = eff ? 4 : 8
  const partners = eff ? [...focus].slice(0, eff.partners + 1) : [...focus]
  const finish = (base: State, mis: Mis, n: number) => {
    const used = placedIn(M, base)
    const slots = { ...input.slotsFree }
    for (const kk of ['weapon', 'supply', 'lavalux'] as SlotKind[]) slots[kk] = Math.max(0, slots[kk] - base.used[GK.indexOf(kk)])
    {
      const st = cloneState(base)
      // Counted: the rest is left to the annealing (it raises divisions from what is left). Packing it
      // here takes the bundle solver hundreds of milliseconds a call, dozens of calls per count.
      if (!eff) fillGreedy(M, input, st, new Set(used), { ...slots }, deadline, fillFrom, fillRounds)
      consider(st, mis, n)
    }
    if (focus.has(mis))
      for (const partner of partners) {
        if (partner === mis || Date.now() > deadline) continue
        const st = cloneState(base)
        const u = new Set(used)
        const sl = { ...slots }
        const rest = packMost(input, leftover(input.pool, u), partner, sl, M.maxDivs - live(st).length)
        if (!rest) continue
        place(M, st, rest, u, sl)
        if (!eff) fillGreedy(M, input, st, u, sl, deadline, fillFrom, fillRounds)
        consider(st, mis, n)
      }
  }
  /** Both packers at one count; whether either managed it. */
  const tryCount = (mis: Mis, n: number): boolean => {
    let any = false
    const slots = { ...input.slotsFree }
    const plans = packDivisions(input.pool, mis.m, n, slots, input.forgeLevel)
    if (plans) {
      const base = emptyState(M)
      if (place(M, base, plans, new Set<string>(), slots) === n) {
        any = true
        finish(base, mis, n)
      }
    }
    const base = balancedPack(M, mis, n, r)
    if (base) {
      any = true
      finish(base, mis, n)
    }
    // Dealt for equal move cost, when the player asked for matching: the shape the balancing starts from.
    if (input.alignMove && n > 1) {
      const dealt = dealPack(M, mis, n, r)
      if (dealt) {
        any = true
        finish(dealt, mis, n)
      }
    }
    // Grown out of the army as it stands, when it has divisions at all.
    if (live(asIs).length) {
      const grown = packFromAsIs(M, asIs, mis, n, r)
      if (grown) {
        any = true
        finish(grown, mis, n)
      }
    }
    return any
  }
  // Most promising mission first; for each, the likely count first, then upward until both packers
  // fail (past what the army already fields), then downward to one.
  outer: for (const mis of byPromise.slice(0, input.effort ? input.effort.missions : Infinity)) {
    const floor = tried.get(mis.m.id)?.count ?? 0
    const n0 = Math.max(1, Math.min(M.maxDivs, Math.max(estimate(mis), floor)))
    const span = eff ? eff.counts : Infinity
    for (let n = n0; n <= M.maxDivs && n <= n0 + span; n++) {
      if (Date.now() > deadline) break outer
      if (!tryCount(mis, n) && n > floor) break
    }
    for (let n = n0 - 1; n >= Math.max(1, n0 - span); n--) {
      if (Date.now() > deadline) break outer
      tryCount(mis, n)
    }
  }
  states.sort((a, b) => b.value - a.value)
  return { states: states.map((x) => x.s), tried: [...tried.values()].sort((a, b) => b.perHour - a.perHour || b.count - a.count), moves: burstMoves }
}

// ---- Checking the answer and writing it out --------------------------------------------------------

/**
 * Every division of the answer, recomputed from its cards with the contract's formula from
 * lib/stats (independent of the search's own evaluator), and checked against its mission, its
 * warlord's crew limit, the Forge slots, the allowance and double use. A division that fails any
 * of it is left out and reported, so nothing is proposed that the chain would refuse.
 */
function verified(M: Model, s: State, input: SearchInput): { divisions: PlannedDivision[]; warnings: string[] } {
  const warnings: string[] = []
  const seen = new Set<string>()
  const used = [0, 0, 0, 0]
  const existingByLeader = new Map(input.existing.flatMap((d) => (d.leader ? [[d.leader.assetId, d] as const] : [])))
  const out: PlannedDivision[] = []
  for (const d of s.divs) {
    if (d.w < 0 || d.k < 0 || !d.mercs.length) continue
    const units: PlannedUnit[] = []
    evalDiv(M, d, units)
    const warlord = M.warlords[d.w]
    const mis = M.missions[d.k]
    let atk = 0
    let def = 0
    let move = 0
    for (const u of units) {
      const t = unitTotals({
        unit: u.merc.stats,
        weapon: u.gear.weapon?.stats,
        supply: u.gear.supply?.stats,
        creature: u.gear.creature?.stats,
        lavalux: u.gear.lavalux?.stats
      })
      atk += t.atk
      def += t.def
      move += t.move
    }
    move = Math.max(0, move - warlord.red)
    const problems: string[] = []
    if (atk !== d.atk || def !== d.def || move !== d.move) problems.push('its numbers did not match the contract formula')
    if (atk < mis.minAtk || def < mis.minDef) problems.push(`it does not meet ${mis.m.title}`)
    if (units.length > warlord.slots) problems.push('it has more crew than its warlord leads')
    const ids = [warlord.ref.assetId, ...units.flatMap((u) => [u.merc.assetId, ...GK.flatMap((k) => (u.gear[k] ? [u.gear[k]!.assetId] : []))])]
    if (ids.some((id) => seen.has(id))) problems.push('it shares a card with another division')
    GK.forEach((k, kind) => {
      const n = units.filter((u) => u.gear[k]).length
      if (used[kind] + n > M.caps[kind]) problems.push(`it needs more ${k} slots than the army has`)
    })
    if (out.length >= M.maxDivs) problems.push('it is one division more than allowed')
    if (problems.length) {
      warnings.push(`A division under ${warlord.ref.name} was left out: ${problems.join('; ')}.`)
      continue
    }
    for (const id of ids) seen.add(id)
    GK.forEach((k, kind) => (used[kind] += units.filter((u) => u.gear[k]).length))
    const existing = existingByLeader.get(warlord.ref.assetId)
    const unchanged =
      !!existing &&
      existing.units.length === units.length &&
      units.every((u) => {
        const now = existing.units.find((x) => x.asset.assetId === u.merc.assetId)
        return !!now && GK.every((k) => (now.gear[k]?.assetId ?? '') === (u.gear[k]?.assetId ?? ''))
      })
    out.push({ warlord: warlord.ref, units, mission: mis.m, atk, def, move, pace: move, perHour: 0, existingId: existing?.id, unchanged })
  }
  // Every division earns at its own move cost: the player claims each as soon as it is back.
  for (const d of out) {
    const mis = M.missions.find((x) => x.m === d.mission)!
    d.pace = d.move
    d.perHour = rate(mis, d.move)
  }
  out.sort((a, b) => b.perHour - a.perHour)
  return { divisions: out, warnings }
}

/**
 * What the cards can field, on their own: the coverage pass over everything, with the army as it
 * stands as the floor, and nothing else. For the page to say, for any account and whatever is out
 * right now, the most divisions of each mission this wallet can run at once and what that army
 * would earn. Bounded by `budgetMs`; the most promising missions are tried first.
 */
/**
 * Development only: what the balancing is up against for this army. The army as it stands under
 * the balancing objective, what the direct packers build for its main mission at the same count,
 * how many random balancing changes from each start leave every division valid, and where a short
 * balancing run from each start ends. Read in the browser console; not part of the product.
 */
export function balanceDiagnostics(input: SearchInput, ms = 12_000): unknown {
  const M = modelOf(input)
  const M2: Model = { ...M, alignMove: true, frozen: true }
  const r = rng(input.seed ?? 1)
  const describe = (s: State) => {
    const o = objective(M2, s)
    const divs = live(s).map((di) => {
      const d = s.divs[di]
      const mis = d.k >= 0 ? M.missions[d.k] : null
      return { mission: mis?.m.title ?? '-', move: d.move, atk: d.atk, def: d.def, need: mis?.minAtk ?? 0, mercs: d.mercs.length, gear: d.gear.map((g) => g.length) }
    })
    return { earn: +o.earn.toFixed(1), score: o.real < -1e8 ? 'invalid' : +o.real.toFixed(1), divs }
  }
  const acceptance = (s0: State, n = 20_000) => {
    const s = cloneState(s0)
    const base = objective(M2, s)
    let made = 0
    let valid = 0
    let better = 0
    let betterValid = 0
    const log: Undo[] = []
    for (let i = 0; i < n; i++) {
      if (!randomMove(M2, s, r, log)) {
        rollback(log)
        continue
      }
      made++
      const o = objective(M2, s)
      if (o.real > -1e8) valid++
      if (o.guided > base.guided + 1e-9) better++
      if (o.real > base.real + 1e-9) betterValid++
      rollback(log)
    }
    return { tried: n, made, valid, better, betterValid }
  }
  const settle = (s0: State) => {
    const st = cloneState(s0)
    const log: Undo[] = []
    trimMoves(M2, st, live(st), log)
    balanceGroups(M2, st, log)
    exchangePass(M2, st, Date.now() + 4000)
    return st
  }
  const run = (s0: State, budget: number) => {
    const st = settle(s0)
    const b: Best = { state: cloneState(st), real: objective(M2, st).real }
    const t0 = Math.max(temperature(M2, st, r), 0.02 * Math.max(1, objective(M2, st).earn))
    const stop = Date.now() + budget
    let round = 0
    while (Date.now() < stop) {
      anneal(M2, st, t0 * Math.pow(0.7, round % 8), t0 / 400, r, b, stop, undefined, ROUND_MOVES / 4)
      const m = settle(b.state)
      const v = objective(M2, m).real
      if (v > b.real + 1e-9) b.state = m, (b.real = v)
      Object.assign(st, cloneState(b.state))
      round++
    }
    polish(M2, b.state, Date.now() + 3000)
    return { rounds: round, t0: +t0.toFixed(2), ...describe(b.state) }
  }
  const asIs = asIsState(M, input)
  const out: Record<string, unknown> = { asIs: describe(asIs), asIsAcceptance: acceptance(asIs) }
  // The mission the army uses most, at the count it fields.
  const counts = new Map<number, number>()
  for (const di of live(asIs)) if (asIs.divs[di].k >= 0) counts.set(asIs.divs[di].k, (counts.get(asIs.divs[di].k) ?? 0) + 1)
  const [k, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [-1, 0]
  if (k >= 0) {
    const mis = M.missions[k]
    out.mission = { title: mis.m.title, count: n, base: mis.base }
    const packs: Record<string, State | null> = {
      dealPack: dealPack(M, mis, n, r),
      balancedPack: balancedPack(M, mis, n, r),
      packFromAsIs: packFromAsIs(M, asIs, mis, n, r),
      balancedPackPlusOne: balancedPack(M, mis, n + 1, r)
    }
    for (const [name, st] of Object.entries(packs)) {
      if (!st) {
        out[name] = null
        continue
      }
      // Divisions the packer left without a mission are taken out so the frozen view can judge the rest.
      const log: Undo[] = []
      for (const di of live(st)) if (st.divs[di].k < 0) dissolve(st, di, log)
      out[name] = { ...describe(st), settled: describe(settle(st)), acceptance: acceptance(st), run: run(st, ms) }
    }
  }
  out.asIsRun = run(asIs, ms)
  return out
}

export function potentialArmy(input: SearchInput): { tried: Tried[]; perHour: number; nowPerHour: number; ms: number } {
  const started = Date.now()
  const M = modelOf(input)
  const r = rng(input.seed ?? 7)
  const asIs = asIsState(M, input)
  const nowPerHour = objective(M, asIs).earn
  if (!M.missions.length || !M.warlords.length || !M.mercs.length || M.maxDivs <= 0) return { tried: [], perHour: nowPerHour, nowPerHour, ms: 0 }
  const cov = coverage(M, input, asIs, started + Math.max(2000, input.budgetMs), r)
  const perHour = cov.states.length ? Math.max(nowPerHour, objective(M, cov.states[0]).real) : nowPerHour
  return { tried: cov.tried, perHour, nowPerHour, ms: Date.now() - started }
}

// ---- Putting it together --------------------------------------------------------------------------

/**
 * The search. `onProgress` hears how far along it is; `onBest` gets the best army so far (checked
 * and written out) whenever it improves, at most about once a second, so a page can show it while
 * the search goes on.
 */
export function searchArmy(
  input: SearchInput,
  onProgress?: (p: SearchProgress) => void,
  onBest?: (result: SearchResult) => void
): SearchResult {
  const started = Date.now()
  const total = Number.isFinite(input.budgetMs) ? Math.max(2000, input.budgetMs) : Infinity
  const ph: PhaseBudgets = input.phases ?? {
    coverageMs: total * 0.35,
    annealMs: total * (input.alignMove ? 0.4 : 0.55),
    balanceMs: total * 0.2
  }
  // Each phase keeps its own clock, so the progress says how far into this phase it is.
  let phaseStart = started
  let phaseMs = Infinity
  const begin = (ms: number) => {
    phaseStart = Date.now()
    phaseMs = ms
  }
  const pct = () => (Number.isFinite(phaseMs) ? Math.min(1, (Date.now() - phaseStart) / Math.max(1, phaseMs)) : -1)
  const M = modelOf(input)
  const r = rng(input.seed ?? 7)
  let moves = 0
  /** Moves made inside the coverage pass, counted while it runs. */
  let extra = 0
  const progress = (phase: SearchProgress['phase'], best: number) =>
    onProgress?.({ phase, pct: pct(), ms: Date.now() - started, phaseMs, best, moves: moves + extra })

  const asIs = asIsState(M, input)
  const nowPerHour = objective(M, asIs).earn
  const best: Best = { state: cloneState(asIs), real: nowPerHour }
  let greedyPerHour = nowPerHour
  let tried: Tried[] = []
  progress('starting', best.real)

  let lastShown = 0
  /** The best balanced army so far (during balancing), shown alongside the best one. */
  let liveBalanced: { M2: Model; state: State } | null = null
  const show = (force = false) => {
    if (!onBest || (!force && Date.now() - lastShown < 1000)) return
    lastShown = Date.now()
    const v = verified(M, best.state, input)
    let balanced: SearchResult['balanced']
    if (liveBalanced) {
      const vb = verified(liveBalanced.M2, liveBalanced.state, input)
      balanced = {
        divisions: vb.divisions,
        perHour: vb.divisions.reduce((n, d) => n + d.perHour, 0),
        warnings: vb.warnings,
        score: objective(liveBalanced.M2, liveBalanced.state).real,
        goalReached: groupSpreads(liveBalanced.M2, liveBalanced.state).every((g) => g.spread <= liveBalanced!.M2.matchGoal)
      }
    }
    onBest({
      balanced,
      divisions: v.divisions,
      perHour: v.divisions.reduce((n, d) => n + d.perHour, 0),
      nowPerHour,
      greedyPerHour,
      moves,
      ms: Date.now() - started,
      converged: false,
      warnings: v.warnings,
      tried
    })
  }

  // The army as it stands goes out first, so a page has something to show while the search runs.
  show(true)

  // Nothing to field: no missions pay, or no warlord and mercenary to field.
  if (M.missions.length && M.warlords.length && M.mercs.length && M.maxDivs > 0) {
    // Every mission at every count, each a whole army: the systematic part of the search.
    begin(ph.coverageMs)
    progress('coverage', best.real)
    const work = input.effort
    const cov = coverage(M, input, asIs, work ? Infinity : phaseStart + ph.coverageMs, r, (n) => {
      extra = n
      progress('coverage', best.real)
    }, (st, v) => {
      // An improvement is shown the moment it is found, not when the pass is over.
      if (v > best.real + 1e-9) {
        best.real = v
        best.state = cloneState(st)
        show()
      }
    })
    tried = cov.tried
    moves += cov.moves
    extra = 0
    for (const st of cov.states.slice(0, 4)) {
      const v = objective(M, st).real
      greedyPerHour = Math.max(greedyPerHour, v)
      if (v > best.real + 1e-9) {
        best.real = v
        best.state = cloneState(st)
        show(true)
      }
    }
    // The greedy construction, with a slice of the budget. Left out when the work is counted: it runs
    // on a clock of its own, and the coverage sweep starts from stronger armies anyway.
    let greedy: State | null = null
    if (!work) {
      begin(5_000)
      progress('greedy', best.real)
      greedy = greedyState(M, input, Math.min(5_000, Number.isFinite(ph.annealMs) ? ph.annealMs * 0.1 : 5_000))
    }
    if (greedy) {
      const v = objective(M, greedy).real
      greedyPerHour = Math.max(greedyPerHour, v)
      if (v > best.real + 1e-9) {
        best.real = v
        best.state = cloneState(greedy)
        show(true)
      }
    }

    // Three lineages take turns; the one that does best gets the rest of the time.
    progress('annealing', best.real)
    const lineages: { name: string; state: State; t0: number; best: Best }[] = []
    // The army as it stands, trimmed: every division cut down to what its mission needs, which lowers
    // its move and raises what it earns; over-built divisions are the common case.
    const trimmedAsIs = cloneState(asIs)
    {
      const log: Undo[] = []
      trimMoves(M, trimmedAsIs, live(trimmedAsIs), log)
      const v = objective(M, trimmedAsIs).real
      if (v > best.real + 1e-9) {
        best.real = v
        best.state = cloneState(trimmedAsIs)
        show(true)
      }
    }
    const starts: [string, State | null][] = [
      ...cov.states.slice(0, 4).map((st, i): [string, State] => [`coverage-${i + 1}`, st]),
      ['trimmed', trimmedAsIs],
      ['greedy', greedy],
      ['as-is', asIs],
      ['empty', emptyState(M)]
    ]
    for (const [name, state] of starts) {
      if (!state) continue
      const own = cloneState(state)
      // Calibrated on the start, but never so cold that a start where every change hurts stands still.
      const t0 = Math.max(temperature(M, own, r), 0.02 * Math.max(1, objective(M, own).earn))
      lineages.push({ name, state: own, t0, best: { state: cloneState(own), real: objective(M, own).real } })
    }
    begin(work ? Infinity : ph.annealMs)
    const unlimited = !!work || !Number.isFinite(ph.annealMs)
    const annealEnd = work ? Infinity : phaseStart + ph.annealMs
    const maxRounds = work ? work.rounds * lineages.length : Infinity
    let cold = false
    // Not before most of the phase's time is used, and not while any lineage still finds something.
    const earliestStop = phaseStart + ph.annealMs * 0.6
    // With no time limit: only once every lineage has had this many cold rounds in a row with nothing.
    const COLD_ROUNDS = unlimited ? 5 : 3
    let since = 0
    let round = 0
    while (Date.now() < annealEnd && round < maxRounds) {
      const l = lineages[round % lineages.length]
      const before = best.real
      const stop = unlimited ? Infinity : Math.min(annealEnd, Date.now() + (annealEnd - Date.now()) / Math.max(1, 4 - Math.floor(round / lineages.length)))
      // Later rounds start from the lineage's best and run cooler.
      const reheats = Math.floor(round / lineages.length)
      moves += anneal(M, l.state, l.t0 * Math.pow(0.5, reheats), l.t0 / 400, r, l.best, stop, () => {
        if (l.best.real > best.real + 1e-9) {
          best.real = l.best.real
          best.state = cloneState(l.best.state)
          show()
        }
      })
      l.state = cloneState(l.best.state)
      round++
      since = best.real > before + 1e-9 ? 0 : since + 1
      progress('annealing', best.real)
      // Most of the time used and every lineage had enough cold rounds in a row without finding anything.
      if ((unlimited || Date.now() > earliestStop) && reheats >= COLD_ROUNDS && since >= lineages.length * COLD_ROUNDS) {
        cold = true
        break
      }
      // After two full passes, only the three best lineages carry on.
      if (round === lineages.length * 2 && lineages.length > 3) {
        lineages.sort((a, b) => b.best.real - a.best.real)
        lineages.length = 3
      }
    }
    const converged = work ? cold : Date.now() < annealEnd
    begin(work ? Infinity : 20_000)
    progress('polishing', best.real)
    // The polish ends when nothing helps any more (or after its round cap); counted, it has no clock.
    moves += polish(M, best.state, work ? Infinity : Date.now() + 20_000)
    // Who carries what, unit by unit: the player's own pairing where it still applies.
    const ownPairs = new Map<number, number[]>()
    for (const d of asIs.divs) if (d.fixed) for (const [m, g] of d.fixed) ownPairs.set(m, g)
    {
      // Divisions that meet nothing earn nothing; out they go, so the frozen view can judge the rest.
      const log: Undo[] = []
      for (const di of live(best.state)) if (best.state.divs[di].k < 0) dissolve(best.state, di, log)
    }
    const xRounds = work ? work.exchange : 15
    exchangeAll({ ...M, frozen: true }, best.state, work ? Infinity : Math.min(started + total, Date.now() + 5000), xRounds)
    repairAll(M, best.state, ownPairs, work ? Infinity : started + total)
    exchangeAll({ ...M, frozen: true }, best.state, work ? Infinity : Math.min(started + total, Date.now() + 3000), Math.ceil(xRounds / 3))
    best.real = objective(M, best.state).real
    // The second answer: the best army balanced for move cost, without giving up much income.
    let balanced: SearchResult['balanced']
    if (input.alignMove) {
      begin(work ? Infinity : ph.balanceMs)
      progress('balancing', best.real)
      // The real divisions of the best answer (by mission) stay: a side division earning under a tenth
      // of the best division's mission may come and go, nothing else.
      const keep = new Map<number, number>()
      {
        const fielded = live(best.state).filter((di) => best.state.divs[di].k >= 0)
        const top = Math.max(0, ...fielded.map((di) => rate(M.missions[best.state.divs[di].k], 0)))
        for (const di of fielded) {
          const k = best.state.divs[di].k
          if (rate(M.missions[k], 0) >= 0.1 * top) keep.set(k, (keep.get(k) ?? 0) + 1)
        }
      }
      const M2: Model = { ...M, alignMove: true, frozen: true, keep }
      const unlimitedBalance = !!work || !Number.isFinite(ph.balanceMs)
      const stop = work ? Infinity : phaseStart + ph.balanceMs
      /*
       * Several starting points, not one: the best army, what the other lineages ended on (often a
       * different set of divisions), and the army as it stands, which may already be better balanced
       * than anything built from the best. Each is evened out outright first; a start with a division
       * that pays nothing cannot be balanced in place and is left out (unless nothing else is left).
       */
      type Run = { name: string; st: State; b: Best; t0: number; round: number; cold: number }
      // A fresh deal for equal move cost at each mission and count (two or more) that the best army or
      // the army as it stands fields, the rest of the army filled in around it.
      const dealt: [string, State][] = []
      const dealtAt = new Set<string>()
      // Counted, the rest of a deal is filled from the missions the best army or the army as it stands
      // field: the ones that matter, in a fixed order, without a clock.
      const fielded = M.missions.filter((_, k) => [best.state, asIs].some((st) => live(st).some((di) => st.divs[di].k === k)))
      for (const from of [best.state, asIs]) {
        const counts = new Map<number, number>()
        for (const di of live(from)) if (from.divs[di].k >= 0) counts.set(from.divs[di].k, (counts.get(from.divs[di].k) ?? 0) + 1)
        // The count the army fields, and one fewer and one more: the odd division out may be better
        // left off (or one more may fit) once the move costs have to match.
        for (const [k, has] of counts)
          for (const n of [has, has + 1]) {
            if (n < 2 || n > M.maxDivs || dealtAt.has(`${k}:${n}`) || Date.now() > stop) continue
            dealtAt.add(`${k}:${n}`)
            const st = dealPack(M, M.missions[k], n, r)
            if (!st) continue
            const slots = { ...input.slotsFree }
            for (const kk of ['weapon', 'supply', 'lavalux'] as SlotKind[]) slots[kk] = Math.max(0, slots[kk] - st.used[GK.indexOf(kk)])
            // Cards the deal does not need come out first, so the rest of the army has them to work with.
            trimMoves(M, st, live(st), [])
            fillGreedy(M, input, st, placedIn(M, st), slots, work ? Infinity : Date.now() + 2000, work ? fielded : M.missions)
            dealt.push([`deal-${M.missions[k].m.title}-${n}`, st])
          }
      }
      /** A state with every division that meets nothing taken out: the frozen view cannot judge it otherwise. */
      const judgeable = (from: State) => {
        const st = cloneState(from)
        const log: Undo[] = []
        for (const di of live(st)) if (st.divs[di].k < 0 || !st.divs[di].mercs.length) dissolve(st, di, log)
        return st
      }
      const covStarts = cov.states
        .map((st, i) => {
          const j = judgeable(st)
          return { name: `coverage-${i + 1}`, st: j, v: objective(M2, j).real }
        })
        .filter((x) => x.v > -1e8)
        .sort((a, b) => b.v - a.v)
        .slice(0, work ? work.balanceStarts : 8)
        .map((x): [string, State] => [x.name, x.st])
      const seeds: [string, State][] = [
        ['best', best.state],
        ...covStarts,
        ...lineages.map((l): [string, State] => [l.name, l.best.state]),
        ['as-is', asIs],
        ['trimmed', trimmedAsIs],
        ...dealt
      ]
      const runs: Run[] = []
      const seen = new Set<string>()
      /** Trimmed, evened out pairwise, then every exchange tried: the settled form of a state. */
      const settle = (st: State) => {
        const log: Undo[] = []
        trimMoves(M2, st, live(st), log)
        balanceGroups(M2, st, log)
        exchangePass(M2, st, work ? Infinity : Math.min(stop, Date.now() + 4000))
        repairAll(M2, st, ownPairs, work ? Infinity : started + total)
      }
      const seed = (name: string, from: State, strict: boolean) => {
        const st = judgeable(from)
        settle(st)
        const v = objective(M2, st).real
        if (strict && v < -1e8) return
        const key = signature(st)
        if (seen.has(key)) return
        seen.add(key)
        const t0 = Math.max(temperature(M2, st, r), 0.02 * Math.max(1, objective(M2, st).earn))
        runs.push({ name, st, b: { state: cloneState(st), real: v }, t0, round: 0, cold: 0 })
      }
      /*
       * Free balancing: the rearrange again, with move-matching counted from the start and nothing
       * frozen, so divisions may change mission, come and go. From the best army, the best coverage
       * army and the best deal (by the matched score); what each ends on is one more starting point
       * for the frozen balancing below, which then evens it out card by card.
       */
      {
        const M3: Model = { ...M, alignMove: true, keep }
        const byMatched = (list: [string, State][]) =>
          list
            .map(([n, st]) => ({ n, st, v: objective(M3, st).real }))
            .filter((x) => x.v > -1e8)
            .sort((a, b) => b.v - a.v)
        const free = [
          { n: 'best', st: best.state },
          ...byMatched(covStarts).slice(0, 1),
          ...byMatched(dealt).slice(0, work ? (work.balanceRuns >= 5 ? 2 : 1) : 1)
        ]
        const rounds = work ? work.rounds : 3
        for (const f of free) {
          const st = cloneState(f.st)
          const b: Best = { state: cloneState(st), real: objective(M3, st).real }
          const t0 = Math.max(temperature(M3, st, r), 0.02 * Math.max(1, objective(M3, st).earn))
          for (let k = 0; k < rounds && Date.now() < stop; k++) {
            moves += anneal(M3, st, t0 * Math.pow(0.5, k), t0 / 400, r, b, work ? Infinity : stop)
            Object.assign(st, cloneState(b.state))
            progress('balancing', best.real)
          }
          seeds.push([`free-${f.n}`, b.state])
        }
      }
      for (const [name, from] of seeds) seed(name, from, true)
      if (!runs.length) seed('best', best.state, false)
      runs.sort((a, b) => b.b.real - a.b.real)
      // The best few, and always the best deal: it may start lower and still be the right basin.
      const deal = runs.find((x) => x.name.startsWith('deal'))
      runs.length = Math.min(runs.length, work ? work.balanceRuns : 4)
      if (deal && !runs.includes(deal)) runs[runs.length - 1] = deal
      // Counted: so many turns for each starting point (the loop narrows to the best two after three each).
      const maxTurns = work ? Math.max(runs.length * 3, 2 * work.balanceTurns + runs.length) : Infinity
      let bb: Best = { state: cloneState(runs[0].b.state), real: runs[0].b.real }
      liveBalanced = { M2, state: bb.state }
      show(true)
      // The runs take turns, like the lineages: a cooling round each, evened out outright after it,
      // reheated when a few rounds in a row found nothing. Only the time ends it; with no limit, it
      // ends when every run has gone cold for good.
      const COLD = unlimitedBalance ? 6 : 4
      for (let turn = 0; Date.now() < stop && turn < maxTurns; turn++) {
        const open = unlimitedBalance ? runs.filter((x) => x.cold < COLD) : runs
        if (!open.length) break
        const run = open[turn % open.length]
        const before = run.b.real
        const heat = run.cold > 0 && run.cold % 3 === 0 ? 1 : Math.pow(0.7, run.round % 8)
        // Shorter rounds than the main search: more time at the temperatures where a small trade matters.
        moves += anneal(M2, run.st, run.t0 * heat, run.t0 / 400, r, run.b, stop, undefined, ROUND_MOVES / 4)
        {
          // Settled outright: the annealing finds the units, this evens them out and tries every exchange.
          const m = cloneState(run.b.state)
          settle(m)
          const v = objective(M2, m).real
          if (v > run.b.real + 1e-9) run.b = { state: m, real: v }
        }
        run.round++
        run.cold = run.b.real > before + 1e-9 ? 0 : run.cold + 1
        Object.assign(run.st, cloneState(run.b.state))
        if (run.b.real > bb.real + 1e-9) {
          bb = { state: cloneState(run.b.state), real: run.b.real }
          liveBalanced = { M2, state: bb.state }
          show()
        }
        // After a few turns each, the rest of the time goes to the two that do best.
        if (turn === runs.length * 3 - 1 && runs.length > 2) {
          runs.sort((a, b) => b.b.real - a.b.real)
          runs.length = 2
        }
      }
      // The finish, for every run's best and not just the leader: the leader before the finish is not
      // always the leader after it (a run that left cards spare gains the most from the top-up).
      {
        const finals = [bb, ...runs.map((x) => x.b)]
        const done = new Set<string>()
        let winner: Best | null = null
        for (const f of finals) {
          const key = signature(f.state)
          if (done.has(key)) continue
          done.add(key)
          const st = cloneState(f.state)
          moves += polish(M2, st, work ? Infinity : Date.now() + 10_000)
          topUp(M, M2, input, st, fielded)
          repairAll(M2, st, ownPairs, work ? Infinity : started + total)
          const v = objective(M2, st).real
          if (v > -1e8 && (!winner || v > winner.real + 1e-9)) winner = { state: st, real: v }
        }
        // The exchanges, on the winner only: they are the costly part of the finish.
        if (winner) {
          exchangeAll(M2, winner.state, work ? Infinity : Math.min(started + total, Date.now() + 3000), work ? work.exchange : 15)
          // The last word on the spread: the balancing exchanges once more, with room to run.
          exchangePass(M2, winner.state, work ? Infinity : Math.min(started + total, Date.now() + 4000), 300)
          repairAll(M2, winner.state, ownPairs, work ? Infinity : started + total)
          winner.real = objective(M2, winner.state).real
        }
        if (winner && winner.real >= bb.real - 1e-9) bb = winner
      }
      // The goal missed for a mission length: said plainly, with the reason when it is plain (a mission
      // the army can only just field leaves no card free to change sides).
      let note: string | undefined
      const missed = groupSpreads(M2, bb.state).filter((g) => g.spread > M2.matchGoal)
      if (missed.length) {
        const parts: string[] = []
        for (const g of missed) {
          const dis = live(bb.state).filter((di) => bb.state.divs[di].k >= 0 && M.missions[bb.state.divs[di].k].base === g.base)
          const byMis = new Map<number, number[]>()
          for (const di of dis) byMis.set(bb.state.divs[di].k, [...(byMis.get(bb.state.divs[di].k) ?? []), di])
          const top = [...byMis].sort((a, b) => b[1].length - a[1].length)[0]
          if (!top) continue
          const mis = M.missions[top[0]]
          const useAtk = mis.minAtk > 0
          const stat = useAtk ? 'atk' : 'def'
          const need = top[1].length * (useAtk ? mis.minAtk : mis.minDef)
          // Every division of the army that needs this stat is counted against the bound.
          const needAll = live(bb.state).reduce((n, di) => {
            const d = bb.state.divs[di]
            return n + (d.k >= 0 ? (useAtk ? M.missions[d.k].minAtk : M.missions[d.k].minDef) : 0)
          }, 0)
          const bound = statBound(M, stat)
          const spare = bound - needAll
          const weakest = Math.min(...M.mercs.map((c) => c[stat]).filter((v) => v > 0))
          const word = useAtk ? 'attack' : 'defense'
          let why = ''
          if (spare < need * 0.02)
            why =
              ` All the cards together make at most ${bound.toLocaleString('en-US')} ${word}, and the divisions need ${needAll.toLocaleString('en-US')}: ${Math.max(0, spare).toLocaleString('en-US')} to spare` +
              (spare < weakest ? ', less than the weakest card adds' : '') +
              ', so hardly a card can change sides. More cards (the wallet, for instance) would give the balancing room.'
          parts.push(`${top[1].length} × ${mis.m.title} could not be brought within the goal; this is the closest the search found.` + why)
        }
        note = parts.join(' ')
      }
      const vb = verified(M2, bb.state, input)
      balanced = {
        divisions: vb.divisions,
        perHour: vb.divisions.reduce((n, d) => n + d.perHour, 0),
        warnings: vb.warnings,
        score: objective(M2, bb.state).real,
        goalReached: !missed.length,
        note
      }
    }
    begin(1_000)
    progress('checking', best.real)
    const v = verified(M, best.state, input)
    // The written-out answer must add up to what the search valued; if not, something is wrong and it is said.
    const written = v.divisions.reduce((n, d) => n + d.perHour, 0)
    const earned = objective(M, best.state).earn
    if (Math.abs(written - earned) > 1e-6) v.warnings.push(`The check added up to ${written.toFixed(2)} TLM/h where the search valued ${earned.toFixed(2)}.`)
    const result: SearchResult = {
      divisions: v.divisions,
      perHour: v.divisions.reduce((n, d) => n + d.perHour, 0),
      nowPerHour,
      greedyPerHour,
      moves,
      ms: Date.now() - started,
      converged,
      warnings: v.warnings,
      tried,
      balanced,
      score: objective(M, best.state).real,
      seed: input.seed
    }
    // Never worse than leaving the army alone, by the score (with move-matching a matched army may earn
    // a little less than the unmatched one it replaces; that is what was asked for).
    if (objective(M, best.state).real + 1e-9 < objective(M, asIs).real) {
      const w = verified(M, asIs, input)
      return { ...result, divisions: w.divisions, perHour: w.divisions.reduce((n, d) => n + d.perHour, 0), warnings: [...v.warnings, ...w.warnings] }
    }
    return result
  }
  const v = verified(M, asIs, input)
  for (const mis of M.missions) {
    const have = asIs.divs.filter((d) => d.w >= 0 && d.mercs.length > 0 && d.atk >= mis.minAtk && d.def >= mis.minDef).length
    if (have) tried.push({ mission: mis.m, count: have, perHour: nowPerHour })
  }
  tried.sort((a, b) => b.perHour - a.perHour || b.count - a.count)
  const reason = !M.missions.length
    ? 'No open mission pays TLM or DEF among the ones allowed.'
    : M.maxDivs <= 0
      ? 'Every division place is taken by a division that is out right now.'
      : !M.warlords.length
        ? 'No warlord is free to lead a division: every staked one leads a division that is out.'
        : 'No mercenary is free to rearrange: every staked one is in a division that is out.'
  return {
    divisions: v.divisions,
    perHour: v.divisions.reduce((n, d) => n + d.perHour, 0),
    nowPerHour,
    greedyPerHour,
    moves: 0,
    ms: Date.now() - started,
    converged: true,
    warnings: v.warnings,
    reason,
    tried
  }
}




