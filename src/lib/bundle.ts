/*
 * Cheapest division for a target ATK and DEF, everything priced in WAX.
 *
 * A division is one warlord (its slots cap the mercenaries) plus mercenaries. Each mercenary can
 * carry one piece of equipment, one supply, one creature and one Lava Lux pass. Equipment,
 * supplies and Lava Lux each use a Forge slot of their kind: the free ones the player already has,
 * then slots bought in the Forge shop for DEF (slot n costs its listed price, and every band of
 * slots needs a higher Forge level, paid in TLM). DEF and TLM are valued at what buying them with
 * WAX on Alcor costs, so a bundle's price is: NFTs + extra slots + Forge levels, all in WAX.
 *
 *   minimise  NFTs + slots + forge level
 *   such that Σ atk ≥ A, Σ def ≥ D, mercenaries ≤ warlord slots, every gear kind ≤ mercenaries,
 *             slots used ≤ free + bought (bought ones need their Forge level)
 *
 * Equipment, supplies and creatures add flat stats, which a dynamic program over a grid of
 * (ATK, DEF) progress handles exactly (1 point per step while the target fits the grid, rounded
 * beyond; answers are always checked against the real stats). Forge levels are tried one by one.
 * Lava Lux multiplies a mercenary's whole line (merc + its gear) and its move cost, which is not
 * additive: it is added afterwards by a local search that also drops what it makes unnecessary.
 */

export type GearKind = 'weapon' | 'supply' | 'creature' | 'lavalux'
type AdditiveGear = 'weapon' | 'supply' | 'creature'
export type SlotKind = 'weapon' | 'supply' | 'lavalux'
export type ItemKind = 'mercenary' | GearKind

export const GEAR_KINDS: GearKind[] = ['weapon', 'supply', 'creature', 'lavalux']
const ADDITIVE: AdditiveGear[] = ['weapon', 'supply', 'creature']
const SLOT_KINDS: SlotKind[] = ['weapon', 'supply', 'lavalux']

export interface Candidate {
  key: string
  kind: ItemKind
  /** Items of one template are interchangeable; used to trim the candidate list. */
  group: string
  atk: number
  def: number
  move: number
  moveReduction: number
  /** Lava Lux multipliers (1 for everything else). */
  atkMult?: number
  defMult?: number
  moveMult?: number
  /** Forge level the NFT needs (ascended NFTs). */
  minLevel: number
  /** WAX. */
  cost: number
}

export interface WarlordOption {
  key: string
  slots: number
  minLevel: number
  cost: number
  /** Move the warlord takes off the whole division (some warlords, e.g. Warmasters). */
  moveReduction?: number
}

/** One Forge shop slot, in purchase order. */
export interface SlotOffer {
  itemId: number
  /** The shop price as the contract wants it, e.g. "10.00000000 DEF". */
  price: string
  priceContract: string
  def: number
  /** What that DEF costs in WAX (marginal, bought on Alcor). */
  wax: number
  level: number
}

export interface Economy {
  forgeLevel: number
  /** WAX to reach each Forge level from now (index = level); 0 at the current level, Infinity if unknown. */
  levelWax: number[]
  /** TLM to reach each level from now, for the transaction. */
  levelTlm: number[]
  slots: Record<SlotKind, { free: number; offers: SlotOffer[] }>
}

export interface SolveInput {
  atk: number
  def: number
  /** The division's move cost may not exceed this (unset: no limit). */
  maxMove?: number
  /** Grid steps per stat at most (default GRID_1D / GRID_2D): a smaller grid is faster and a little coarser. */
  gridMax?: number
  warlords: WarlordOption[]
  items: Candidate[]
  economy: Economy
}

export interface UnitPlan {
  merc: Candidate
  gear: Partial<Record<GearKind, Candidate>>
  atk: number
  def: number
  move: number
}

export interface Bundle {
  /** WAX per move point the move-limit search settled on (0 or unset: no limit was needed). */
  moveLambda?: number
  warlord: WarlordOption
  mercs: Candidate[]
  gear: Record<GearKind, Candidate[]>
  /** Everything in WAX. */
  cost: number
  nftCost: number
  slotCost: number
  forgeCost: number
  /** Forge level the bundle needs. */
  level: number
  slotsBought: Record<SlotKind, SlotOffer[]>
  units: UnitPlan[]
  atk: number
  def: number
  move: number
}

type Parts = Pick<Bundle, 'warlord' | 'mercs' | 'gear'>

// ---- Evaluating a bundle ---------------------------------------------------------------------------

const power = (c: { atk: number; def: number }) => c.atk + c.def

/**
 * Puts the gear on the mercenaries and computes the division, the contract's way: per mercenary,
 * (merc + equipment + supply + creature) × Lava Lux, rounded down; move = (merc move − supply
 * reduction) × Lava Lux move. The strongest weapons and creatures go to the strongest mercenaries;
 * then the strongest Lava Lux (by its multipliers, then the least move it adds) to the units
 * strongest with that gear, so the multiplier works on the most; supplies go where they cut the most move.
 */
export function evaluate(p: Parts): { units: UnitPlan[]; atk: number; def: number; move: number } {
  const units = [...p.mercs].sort((a, b) => power(b) - power(a)).map((merc) => ({ merc, gear: {} as UnitPlan['gear'] }))
  for (const kind of ['weapon', 'creature'] as const) {
    ;[...p.gear[kind]].sort((a, b) => power(b) - power(a)).forEach((g, i) => units[i] && (units[i].gear[kind] = g))
  }
  const lava = [...p.gear.lavalux].sort(
    (a, b) =>
      (b.atkMult ?? 1) + (b.defMult ?? 1) - ((a.atkMult ?? 1) + (a.defMult ?? 1)) || (a.moveMult ?? 1) - (b.moveMult ?? 1)
  )
  const armed = (u: (typeof units)[number]) =>
    power(u.merc) + (u.gear.weapon ? power(u.gear.weapon) : 0) + (u.gear.creature ? power(u.gear.creature) : 0)
  const byArmed = [...units].sort((a, b) => armed(b) - armed(a))
  lava.forEach((l, i) => byArmed[i] && (byArmed[i].gear.lavalux = l))
  // Supplies: the biggest move cuts to the mercenaries with the most move to cut.
  const byMove = [...units].sort(
    (a, b) => b.merc.move * (b.gear.lavalux?.moveMult ?? 1) - a.merc.move * (a.gear.lavalux?.moveMult ?? 1)
  )
  ;[...p.gear.supply]
    .sort((a, b) => b.moveReduction - a.moveReduction)
    .forEach((s, i) => byMove[i] && (byMove[i].gear.supply = s))

  let atk = 0
  let def = 0
  let move = 0
  const plans: UnitPlan[] = units.map(({ merc, gear }) => {
    const add = [merc, gear.weapon, gear.supply, gear.creature].filter((x): x is Candidate => !!x)
    const l = gear.lavalux
    const a = Math.floor(add.reduce((n, x) => n + x.atk, 0) * (l?.atkMult ?? 1))
    const d = Math.floor(add.reduce((n, x) => n + x.def, 0) * (l?.defMult ?? 1))
    const m = Math.round(Math.max(0, merc.move - (gear.supply?.moveReduction ?? 0)) * (l?.moveMult ?? 1))
    atk += a
    def += d
    move += m
    return { merc, gear, atk: a, def: d, move: m }
  })
  // The warlord's move reduction comes off the division's total, as the contract counts it.
  return { units: plans, atk, def, move: Math.max(0, move - (p.warlord.moveReduction ?? 0)) }
}

/** Prices a bundle: NFTs, the slots it needs beyond the free ones, and the Forge level all of that needs. */
function price(p: Parts, input: SolveInput): Bundle {
  const eco = input.economy
  const all = [...p.mercs, ...GEAR_KINDS.flatMap((k) => p.gear[k])]
  const nftCost = p.warlord.cost + all.reduce((n, x) => n + x.cost, 0)
  let level = Math.max(eco.forgeLevel, p.warlord.minLevel, ...all.map((x) => x.minLevel))
  let slotCost = 0
  const slotsBought = { weapon: [], supply: [], lavalux: [] } as Record<SlotKind, SlotOffer[]>
  for (const kind of SLOT_KINDS) {
    const extra = Math.max(0, p.gear[kind].length - eco.slots[kind].free)
    if (extra > eco.slots[kind].offers.length) slotCost = Infinity
    const bought = eco.slots[kind].offers.slice(0, extra)
    slotsBought[kind] = bought
    slotCost += bought.reduce((n, o) => n + o.wax, 0)
    for (const o of bought) level = Math.max(level, o.level)
  }
  const forgeCost = eco.levelWax[level] ?? Infinity
  const ev = evaluate(p)
  return { ...p, ...ev, nftCost, slotCost, forgeCost, level, slotsBought, cost: nftCost + slotCost + forgeCost }
}

export const valid = (b: Bundle, input: SolveInput) =>
  Number.isFinite(b.cost) &&
  b.mercs.length > 0 &&
  b.atk >= input.atk &&
  b.def >= input.def &&
  b.mercs.length <= b.warlord.slots &&
  GEAR_KINDS.every((k) => b.gear[k].length <= b.mercs.length)

// ---- The grid dynamic program (flat-stat gear) --------------------------------------------------

interface Grid {
  ga: number
  gd: number
  cells: number
  target: number
  aOf: Int16Array
  dOf: Int16Array
}

function makeGrid(ga: number, gd: number): Grid {
  const cells = (ga + 1) * (gd + 1)
  const aOf = new Int16Array(cells)
  const dOf = new Int16Array(cells)
  for (let c = 0; c < cells; c++) {
    aOf[c] = Math.floor(c / (gd + 1))
    dOf[c] = c % (gd + 1)
  }
  return { ga, gd, cells, target: cells - 1, aOf, dOf }
}

interface Q {
  item: Candidate
  ua: number
  ud: number
}

const step = (g: Grid, c: number, ua: number, ud: number) =>
  Math.min(g.ga, g.aOf[c] + ua) * (g.gd + 1) + Math.min(g.gd, g.dOf[c] + ud)

/**
 * 0/1 knapsack with an item count from `start`. Returns the cost layer per count 0…cap and, when
 * tracking, per item the cell each improved state came from (+1; 0 = not improved by it).
 */
function countKnapsack(g: Grid, start: Float64Array, items: Q[], cap: number, track: boolean) {
  const layers: Float64Array[] = [Float64Array.from(start)]
  for (let j = 1; j <= cap; j++) layers.push(new Float64Array(g.cells).fill(Infinity))
  const trail: Int16Array[] = []
  items.forEach((q, i) => {
    const t = track ? new Int16Array((cap + 1) * g.cells) : null
    for (let j = Math.min(cap - 1, i); j >= 0; j--) {
      const from = layers[j]
      const to = layers[j + 1]
      for (let c = 0; c < g.cells; c++) {
        const base = from[c]
        if (base === Infinity) continue
        const nc = step(g, c, q.ua, q.ud)
        const cand = base + q.item.cost
        if (cand < to[nc]) {
          to[nc] = cand
          if (t) t[(j + 1) * g.cells + nc] = c + 1
        }
      }
    }
    if (t) trail.push(t)
  })
  return { layers, trail }
}

/** Min over counts per cell, with `extra[j]` added for count j (the slots j items need), and which count won. */
function collapse(g: Grid, layers: Float64Array[], extra: (j: number) => number) {
  const best = new Float64Array(g.cells).fill(Infinity)
  const at = new Int16Array(g.cells)
  layers.forEach((layer, j) => {
    const add = extra(j)
    if (!Number.isFinite(add)) return
    for (let c = 0; c < g.cells; c++) {
      const v = layer[c] + add
      if (v < best[c]) {
        best[c] = v
        at[c] = j
      }
    }
  })
  return { best, at }
}

function backtrack(g: Grid, items: Q[], trail: Int16Array[], count: number, cell: number) {
  const chosen: Candidate[] = []
  let j = count
  let c = cell
  for (let i = items.length - 1; i >= 0 && j > 0; i--) {
    const prev = trail[i][j * g.cells + c]
    if (prev) {
      chosen.push(items[i].item)
      c = prev - 1
      j--
    }
  }
  return { chosen, cell: c }
}

/** Keeps the `n` cheapest of every template: no division needs more copies than that. */
function trim(items: Candidate[], n: number): Candidate[] {
  const byGroup = new Map<string, Candidate[]>()
  for (const it of items) byGroup.set(it.group, [...(byGroup.get(it.group) ?? []), it])
  return [...byGroup.values()].flatMap((list) => list.sort((a, b) => a.cost - b.cost).slice(0, Math.max(0, n)))
}

/** Grid steps per stat: exact (1 point per step) while the target fits, coarser beyond. */
const GRID_1D = 4000
const GRID_2D = 90

/** Slots of a kind usable at Forge level L, and the WAX that j of them cost. */
function slotPlan(eco: Economy, kind: SlotKind, L: number) {
  const { free, offers } = eco.slots[kind]
  const usable = offers.filter((o) => o.level <= L)
  const cum = [0]
  for (const o of usable) cum.push(cum[cum.length - 1] + o.wax)
  return {
    available: free + usable.length,
    cost: (j: number) => (j <= free ? 0 : j - free < cum.length ? cum[j - free] : Infinity)
  }
}

/** Everything the grid search at Forge level L works with. */
function prepareGrid(input: SolveInput, ta: number, td: number, L: number) {
  const eco = input.economy
  const levelWax = eco.levelWax[L]
  const both = ta > 0 && td > 0
  const cap = Math.min(both ? GRID_2D : GRID_1D, input.gridMax ?? Infinity)
  const ga = ta > 0 ? Math.min(Math.ceil(ta), cap) : 0
  const gd = td > 0 ? Math.min(Math.ceil(td), cap) : 0
  const g = makeGrid(ga, gd)
  const sa = ga ? ta / ga : 1
  const sd = gd ? td / gd : 1
  const quant = (it: Candidate): Q => ({
    item: it,
    ua: ga ? Math.min(ga, Math.round(it.atk / sa)) : 0,
    ud: gd ? Math.min(gd, Math.round(it.def / sd)) : 0
  })
  const allowed = (it: Candidate) => it.minLevel <= L && ((ga > 0 && it.atk > 0) || (gd > 0 && it.def > 0))
  const warlords = input.warlords.filter((w) => w.minLevel <= L)
  const maxSlots = Math.max(0, ...warlords.map((w) => w.slots))
  const slots = {
    weapon: slotPlan(eco, 'weapon', L),
    supply: slotPlan(eco, 'supply', L),
    creature: { available: Infinity, cost: () => 0 }
  }
  const mercs = trim(
    input.items.filter((i) => i.kind === 'mercenary' && allowed(i)),
    maxSlots
  )
    .map(quant)
    .sort((a, b) => a.item.cost - b.item.cost)
  const gear = Object.fromEntries(
    ADDITIVE.map((k) => [
      k,
      trim(
        input.items.filter((i) => i.kind === k && allowed(i)),
        Math.min(maxSlots, slots[k].available)
      )
        .map(quant)
        .sort((a, b) => a.item.cost - b.item.cost)
    ])
  ) as Record<AdditiveGear, Q[]>

  const K = Math.min(maxSlots, mercs.length)
  const warlordFor = (k: number) =>
    warlords.filter((w) => w.slots >= k).sort((a, b) => a.cost - b.cost || a.slots - b.slots)[0] ?? null
  const capFor = (kind: AdditiveGear, k: number) => Math.min(k, slots[kind].available, gear[kind].length)
  const start = new Float64Array(g.cells).fill(Infinity)
  start[0] = 0
  return { g, levelWax, slots, mercs, gear, K, warlordFor, capFor, start }
}

/** How many mercenaries the grid search at level L may take: the counts it has to try. */
export function gridCounts(input: SolveInput, L: number): number {
  const maxSlots = Math.max(0, ...input.warlords.filter((w) => w.minLevel <= L).map((w) => w.slots))
  const mercs = input.items.filter((i) => i.kind === 'mercenary' && i.minLevel <= L).length
  return Math.min(maxSlots, mercs)
}

/**
 * The cheapest total over the given mercenary counts at level L (level cost included), and the count
 * that gives it. Counts are independent of each other, so they can be split across workers.
 */
export function scanCounts(
  input: SolveInput,
  ta: number,
  td: number,
  L: number,
  counts: number[],
  bound: number
): { k: number; total: number } | null {
  const c = prepareGrid(input, ta, td, L)
  const ks = counts.filter((k) => k >= 1 && k <= c.K && c.warlordFor(k)).sort((a, b) => a - b)
  if (!ks.length) return null
  const g = c.g
  const mercRun = countKnapsack(g, c.start, c.mercs, ks[ks.length - 1], false)
  const withGear = (grid: Float64Array, k: number) => {
    let cur = grid
    for (const kind of ADDITIVE) {
      const cap = c.capFor(kind, k)
      if (cap <= 0) continue
      cur = collapse(g, countKnapsack(g, cur, c.gear[kind], cap, false).layers, c.slots[kind].cost).best
    }
    return cur
  }

  /*
   * A lower bound per count, cheap to get: the gear on its own (from nothing, as if every count had
   * the most mercenaries, so at most K pieces of each kind) is solved once, and for each cell its
   * cheapest cost to reach at least that much. Mercenaries at cell x plus the cheapest gear that
   * covers what x lacks can only cost less than the real answer for that count, which also caps gear
   * at the count. Counts are then tried cheapest bound first, and the expensive exact solve stops as
   * soon as no remaining bound can beat the best found: same answer, a fraction of the work.
   */
  const gearAll = withGear(c.start, c.K)
  const cover = new Float64Array(g.cells)
  for (let ga = g.ga; ga >= 0; ga--)
    for (let gd = g.gd; gd >= 0; gd--) {
      const cell = ga * (g.gd + 1) + gd
      let v = gearAll[cell]
      if (ga < g.ga) v = Math.min(v, cover[cell + g.gd + 1])
      if (gd < g.gd) v = Math.min(v, cover[cell + 1])
      cover[cell] = v
    }
  const lower = (k: number) => {
    const layer = mercRun.layers[k]
    let lb = Infinity
    for (let cell = 0; cell < g.cells; cell++) {
      const m = layer[cell]
      if (m === Infinity) continue
      const need = (g.ga - g.aOf[cell]) * (g.gd + 1) + (g.gd - g.dOf[cell])
      const v = m + cover[need]
      if (v < lb) lb = v
    }
    return lb + c.warlordFor(k)!.cost + c.levelWax
  }
  const order = ks.map((k) => ({ k, lb: lower(k) })).sort((x, y) => x.lb - y.lb || x.k - y.k)

  let best = bound
  let bestK = 0
  for (const { k, lb } of order) {
    // Sorted by bound: once a bound cannot beat the best, none after it can.
    // (A hair of slack: the bound and the exact total add the same costs in a different order.)
    if (lb > best + 1e-6 || (lb >= best - 1e-6 && bestK && k > bestK)) break
    const total = withGear(mercRun.layers[k], k)[g.target] + c.warlordFor(k)!.cost + c.levelWax
    // Equal totals keep the smaller count, as a count-by-count search would.
    if (total < best || (total === best && bestK && k < bestK)) {
      best = total
      bestK = k
    }
  }
  return bestK ? { k: bestK, total: best } : null
}

/** Rebuilds the bundle for one mercenary count at level L, remembering the choices and walking them back. */
export function buildAtCount(input: SolveInput, ta: number, td: number, L: number, k: number): Bundle | null {
  const c = prepareGrid(input, ta, td, L)
  if (k < 1 || k > c.K) return null
  const mercTracked = countKnapsack(c.g, c.start, c.mercs, k, true)
  const stages: { kind: AdditiveGear; trail: Int16Array[]; at: Int16Array }[] = []
  let grid = mercTracked.layers[k]
  for (const kind of ADDITIVE) {
    const cap = c.capFor(kind, k)
    if (cap <= 0) continue
    const run = countKnapsack(c.g, grid, c.gear[kind], cap, true)
    const col = collapse(c.g, run.layers, c.slots[kind].cost)
    stages.push({ kind, trail: run.trail, at: col.at })
    grid = col.best
  }
  const picked: Record<GearKind, Candidate[]> = { weapon: [], supply: [], creature: [], lavalux: [] }
  let cell = c.g.target
  for (let s = stages.length - 1; s >= 0; s--) {
    const st = stages[s]
    const back = backtrack(c.g, c.gear[st.kind], st.trail, st.at[cell], cell)
    picked[st.kind] = back.chosen
    cell = back.cell
  }
  const mercBack = backtrack(c.g, c.mercs, mercTracked.trail, k, cell)
  // The grid only knows how many slots it needs; with the units known, the warlord that leaves the least move.
  if (!c.warlordFor(mercBack.chosen.length)) return null
  return withBestWarlord({ mercs: mercBack.chosen, gear: picked }, input)
}

/** The cheapest flat-stat bundle at Forge level L (level cost included), or null. `bound` prunes. */
function solveGrid(input: SolveInput, ta: number, td: number, L: number, bound: number): Bundle | null {
  const K = gridCounts(input, L)
  const found = scanCounts(
    input,
    ta,
    td,
    L,
    Array.from({ length: K }, (_, i) => i + 1),
    bound
  )
  return found ? buildAtCount(input, ta, td, L, found.k) : null
}

/** Whether going from level L−1 to L unlocks anything: slots, ascended NFTs or warlords. */
export function levelUnlocks(input: SolveInput, L: number) {
  return (
    input.items.some((i) => i.minLevel === L) ||
    input.warlords.some((w) => w.minLevel === L) ||
    SLOT_KINDS.some((k) => input.economy.slots[k].offers.some((o) => o.level === L) && input.items.some((i) => i.kind === k))
  )
}

/** Solves at level L, raising the internal target a grid step at a time when rounding left the answer short. */
/** One grid step of target t: how far rounding can leave an answer short. */
export function gridStep(input: SolveInput, t: number): number {
  const both = input.atk > 0 && input.def > 0
  const cap = Math.min(both ? GRID_2D : GRID_1D, input.gridMax ?? Infinity)
  return t > 0 ? t / Math.min(Math.ceil(t), cap) : 0
}

function solveAtLevel(input: SolveInput, L: number, bound: number): Bundle | null {
  let ta = input.atk
  let td = input.def
  for (let attempt = 0; attempt < 12; attempt++) {
    const b = solveGrid(input, ta, td, L, bound)
    if (!b) return null
    if (valid(b, input)) return b
    if (b.atk < input.atk) ta += input.atk - b.atk + gridStep(input, ta)
    if (b.def < input.def) td += input.def - b.def + gridStep(input, td)
  }
  return null
}

// ---- Local search: Lava Lux, dropping and swapping ----------------------------------------------

const parts = (b: Parts): Parts => ({ warlord: b.warlord, mercs: b.mercs, gear: b.gear })

const without = (b: Parts, it: Candidate): Parts => ({
  warlord: b.warlord,
  mercs: b.mercs.filter((m) => m !== it),
  gear: {
    weapon: b.gear.weapon.filter((m) => m !== it),
    supply: b.gear.supply.filter((m) => m !== it),
    creature: b.gear.creature.filter((m) => m !== it),
    lavalux: b.gear.lavalux.filter((m) => m !== it)
  }
})

const withItem = (b: Parts, it: Candidate): Parts =>
  it.kind === 'mercenary' ? { ...b, mercs: [...b.mercs, it] } : { ...b, gear: { ...b.gear, [it.kind]: [...b.gear[it.kind], it] } }

const contents = (b: Parts) => [...b.mercs, ...GEAR_KINDS.flatMap((k) => b.gear[k])]

/**
 * The warlord for these units, priced: the cheapest that fits; among equally cheap ones the one that
 * leaves the division the least move (warlords of the same kind take different amounts off by their
 * shine), then the fewest slots, then the smallest reduction that does it, so the warlords that take
 * the most off stay free for slower divisions. Warlords alike in slots and reduction are tried once.
 */
function withBestWarlord(p: Omit<Parts, 'warlord'>, input: SolveInput): Bundle | null {
  const fitAll = input.warlords.filter((o) => o.slots >= p.mercs.length)
  if (!fitAll.length) return null
  // A warlord that would need a higher Forge level only when no other fits.
  const atLevel = fitAll.filter((o) => o.minLevel <= input.economy.forgeLevel)
  const fit = atLevel.length ? atLevel : fitAll
  const cheapest = Math.min(...fit.map((o) => o.cost))
  const kinds = new Map<string, WarlordOption>()
  for (const w of fit) if (w.cost === cheapest) kinds.set(`${w.slots}:${w.moveReduction ?? 0}`, kinds.get(`${w.slots}:${w.moveReduction ?? 0}`) ?? w)
  let best: Bundle | null = null
  for (const w of kinds.values()) {
    const b = price({ ...p, warlord: w }, input)
    const better =
      !best ||
      b.move < best.move ||
      (b.move === best.move &&
        (w.slots < best.warlord.slots ||
          (w.slots === best.warlord.slots && (w.moveReduction ?? 0) < (best.warlord.moveReduction ?? 0))))
    if (better) best = b
  }
  return best
}

/** Re-picks the warlord for the units (see withBestWarlord) and prices the result. */
function settle(p: Parts, input: SolveInput): Bundle | null {
  return withBestWarlord({ mercs: p.mercs, gear: p.gear }, input)
}

/** Drops the most expensive items the target does not need, one at a time. */
function shed(b: Bundle, input: SolveInput): Bundle {
  let cur = b
  for (const it of contents(cur).sort((x, y) => y.cost - x.cost)) {
    const next = settle(without(cur, it), input)
    if (next && valid(next, input) && moveOk(next, cur, input) && next.cost < cur.cost) cur = next
  }
  return cur
}

/** One cheapest listing per template for kind, not already used: the moves worth trying. */
function options(input: SolveInput, kind: ItemKind, used: Set<string>) {
  const best = new Map<string, Candidate>()
  for (const it of input.items) {
    if (it.kind !== kind || used.has(it.key)) continue
    const cur = best.get(it.group)
    if (!cur || it.cost < cur.cost) best.set(it.group, it)
  }
  return [...best.values()]
}

/**
 * Improves a bundle until nothing helps: drop what is not needed, swap an item for a cheaper one
 * of its kind, and add a Lava Lux pass (then drop what it makes unnecessary).
 */
export function polish(b: Bundle, input: SolveInput): Bundle {
  let cur = shed(settle(parts(b), input) ?? b, input)
  for (let round = 0; round < 12; round++) {
    let improved = false
    const used = new Set(contents(cur).map((c) => c.key))

    // Lava Lux: try each template on the division, keep the best that pays for itself.
    if (cur.gear.lavalux.length < cur.mercs.length) {
      let bestTry: Bundle | null = null
      for (const lava of options(input, 'lavalux', used)) {
        const added = settle(withItem(parts(cur), lava), input)
        if (!added || !Number.isFinite(added.cost)) continue
        const trimmed = shed(added, input)
        if (valid(trimmed, input) && moveOk(trimmed, cur, input) && trimmed.cost < (bestTry?.cost ?? cur.cost)) bestTry = trimmed
      }
      if (bestTry) {
        cur = bestTry
        improved = true
        continue
      }
    }

    // Swap an item for a cheaper one of the same kind that still meets the target.
    for (const it of contents(cur).sort((x, y) => y.cost - x.cost)) {
      for (const alt of options(input, it.kind, used)) {
        if (alt.cost >= it.cost) continue
        const swapped = settle(withItem(without(cur, it), alt), input)
        if (swapped && valid(swapped, input) && moveOk(swapped, cur, input) && swapped.cost < cur.cost) {
          cur = shed(swapped, input)
          improved = true
          break
        }
      }
      if (improved) break
    }
    if (!improved) break
  }
  return cur
}

// ---- The move limit ---------------------------------------------------------------------------------

/**
 * A change the local search may make: within the move limit, or at least no worse than now (a
 * bundle already over the limit may still get cheaper, just not slower).
 */
const moveOk = (next: Bundle, cur: Bundle, input: SolveInput) => !input.maxMove || next.move <= Math.max(input.maxMove, cur.move)

export const withinMove = (b: Bundle, input: SolveInput) => !input.maxMove || b.move <= input.maxMove

/**
 * The input with every move point priced at `lambda` WAX: mercenaries cost more by their move,
 * supplies less by the move they take off. Solving it trades WAX for a lower move cost; the result
 * is priced again at real costs with reprice().
 */
export function shadeForMove(input: SolveInput, lambda: number): SolveInput {
  if (lambda <= 0) return input
  return {
    ...input,
    items: input.items.map((it) =>
      it.kind === 'mercenary'
        ? { ...it, cost: it.cost + lambda * it.move }
        : it.kind === 'supply'
          ? { ...it, cost: Math.max(0.01, it.cost - lambda * it.moveReduction) }
          : it
    )
  }
}

/** A bundle solved on a shaded input, priced at the real costs of `input`. */
export function reprice(b: Bundle, input: SolveInput): Bundle | null {
  const byKey = new Map(input.items.map((it) => [it.key, it]))
  const real = (list: Candidate[]) => list.map((it) => byKey.get(it.key)!)
  const warlord = input.warlords.find((w) => w.key === b.warlord.key)
  if (!warlord || [...b.mercs, ...GEAR_KINDS.flatMap((k) => b.gear[k])].some((it) => !byKey.has(it.key))) return null
  return price(
    {
      warlord,
      mercs: real(b.mercs),
      gear: {
        weapon: real(b.gear.weapon),
        supply: real(b.gear.supply),
        creature: real(b.gear.creature),
        lavalux: real(b.gear.lavalux)
      }
    },
    input
  )
}

/**
 * Brings a bundle under the move limit at real prices: over and over, the change that takes off the
 * most move for the least WAX (a mercenary swapped for a slower-moving one, a supply added or
 * swapped for a stronger one, a mercenary dropped), as long as the target still holds. Then the usual local search, which keeps
 * within the limit. Returns null when nothing more helps and the bundle is still too slow.
 */
export function fitMoveLimit(b: Bundle, input: SolveInput): Bundle | null {
  if (!input.maxMove) return b
  let cur: Bundle | null = settle(parts(b), input)
  for (let round = 0; cur && !withinMove(cur, input) && round < 60; round++) {
    const now: Bundle = cur
    const used = new Set(contents(now).map((c) => c.key))
    let pick: Bundle | null = null
    let pickScore = Infinity
    const consider = (next: Bundle | null) => {
      if (!next || !valid(next, input) || next.move >= now.move) return
      const score = Math.max(0, next.cost - now.cost) / (now.move - next.move)
      if (score < pickScore || (score === pickScore && next.move < (pick?.move ?? Infinity))) {
        pick = next
        pickScore = score
      }
    }
    const swapIns = options(input, 'mercenary', used)
    for (const m of now.mercs) {
      consider(settle(without(now, m), input))
      for (const alt of swapIns) if (alt.move < m.move) consider(settle(withItem(without(now, m), alt), input))
    }
    const supplies = options(input, 'supply', used)
    // A supply already in the bundle can give way to one that takes off more.
    for (const cur of now.gear.supply)
      for (const alt of supplies)
        if (alt.moveReduction > cur.moveReduction) consider(settle(withItem(without(now, cur), alt), input))
    if (now.gear.supply.length < now.mercs.length)
      for (const sup of options(input, 'supply', used))
        if (sup.moveReduction > 0) consider(settle(withItem(parts(now), sup), input))
    cur = pick
  }
  return cur && withinMove(cur, input) ? polish(cur, input) : null
}

/** Solves at most this many shaded inputs when looking for the price of move. */
const MOVE_SEARCH_STEPS = 6

/**
 * The cheapest bundle within the move limit, for a solver of the unlimited problem. Tries the
 * unpriced problem first (often already within the limit); otherwise prices move points, raising
 * the price until the answer fits and then narrowing it, and keeps the cheapest fitting answer at
 * real prices. `hint` is a price that worked before for this target: it is tried first.
 */
export function searchMoveLimit(input: SolveInput, solve: (input: SolveInput) => Bundle | null, hint?: number): Bundle | null {
  const base = solve(input)
  if (!input.maxMove || !base || withinMove(base, input)) return base
  // The unlimited answer, repaired, is the first candidate.
  let best: Bundle | null = fitMoveLimit(base, input)
  let lo = 0
  let hi = Infinity
  let lambda = hint && hint > 0 ? hint : Math.max(0.01, base.cost / Math.max(1, base.move))
  for (let step = 0; step < MOVE_SEARCH_STEPS; step++) {
    const got = solve(shadeForMove(input, lambda))
    const priced = got && reprice(got, input)
    if (priced && valid(priced, input) && withinMove(priced, input)) hi = lambda
    else lo = lambda
    // Fitted and polished at real prices, whether this price of move was enough or not.
    const b = priced && valid(priced, input) ? fitMoveLimit(priced, input) : null
    if (b && (!best || b.cost < best.cost)) best = { ...b, moveLambda: lambda }
    if (hi !== Infinity && hi - lo < hi * 0.1) break
    lambda = hi === Infinity ? lambda * 3 : (lo + hi) / 2
  }
  return best
}

/** The cheapest valid bundle, or null when the market, your NFTs and the Forge cannot reach the target. */
export function solveBundle(input: SolveInput): Bundle | null {
  return searchMoveLimit(input, solveUnlimited)
}

/** solveBundle without looking at the move limit (the local search still respects it). */
function solveUnlimited(input: SolveInput): Bundle | null {
  if (input.atk <= 0 && input.def <= 0) return null
  if (!input.warlords.length) return null
  const eco = input.economy
  let best: Bundle | null = null
  // Every Forge level from the current one up: each opens more slots (at a TLM price).
  for (let L = eco.forgeLevel; L <= 5; L++) {
    const levelWax = eco.levelWax[L]
    if (levelWax === undefined || !Number.isFinite(levelWax)) continue
    if (best && levelWax >= best.cost) break
    if (L > eco.forgeLevel && !levelUnlocks(input, L)) continue
    const b = solveAtLevel(input, L, best?.cost ?? Infinity)
    if (b && (!best || b.cost < best.cost)) best = b
  }
  return best ? polish(best, input) : null
}
