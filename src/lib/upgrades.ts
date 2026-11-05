import type { AssetRef } from '@/data/assets'
import type { Division, Unit } from '@/data/game'
import type { Blend } from '@/data/blends'
import type { Listing } from '@/data/market'

import type { Economy, SlotKind, SlotOffer } from './bundle'
import { isTokenLoop, meetsRequirements, tlmPerHour, type MissionEconomics } from './loop'
import type { Market } from './market'
import { kindOfCategory, unitTotals, type GearKind } from './stats'

/*
 * The Market's Upgrade list: every single change that makes one of the player's divisions better,
 * priced in WAX. A change puts one NFT somewhere: gear on a mercenary (into an empty place, which
 * may need a Forge slot, or instead of what is there), or a new mercenary into a free place of the
 * division. The NFT comes from the reserve, the wallet, a market listing, a blend or an ascension
 * of the piece already there. Each change is valued alone against the division as it stands: the
 * TLM per hour of the best mission it reaches, and its attack, defense and move cost.
 *
 * The warlord counts too: its move reduction comes off the whole division, so a warlord raised a
 * star (or a better one leading the same troops) is often the biggest saving of all.
 */

export type UpgradeSource = 'reserve' | 'wallet' | 'market' | 'blend' | 'ascend'
export type UpgradeSlot = 'warlord' | 'mercenary' | GearKind
/** What a step is, for its colour on screen. */
export type StepKind = 'owned' | 'forge' | 'blend' | 'ascend' | 'market'

export interface Offer {
  asset: AssetRef
  source: UpgradeSource
  /** WAX for the NFT itself (0 for owned ones). */
  wax: number
  /** What the offer draws on, and how many of it there are (owned copies, listings of the template). */
  res: string
  capacity: number
  listing?: Listing
  blend?: Blend
  /** Ascension: the piece raised a star, and the Fragments it takes (owned ones first). */
  ascend?: {
    from: AssetRef
    fragments: number
    owned: number
    /** Staked now: it has to come out of the game first (a warlord with its division taken apart). */
    staked: boolean
    /** The cheapest Fragments, when buying cards to sacrifice beats buying Fragments. */
    via?: { name: string; perCard: number }
  }
}

export interface UpgradeStep {
  kind: StepKind
  label: string
  detail?: string
}

export interface Stats {
  atk: number
  def: number
  move: number
  /** TLM per hour on the best mission the division reaches (0 if none pays). */
  rate: number
}

export interface Upgrade {
  kind: 'single'
  id: string
  division: Division
  /** The mercenary the gear goes on; unset for a new mercenary. */
  unit?: Unit
  slot: UpgradeSlot
  /** What is in that place now and comes out. */
  replaces?: AssetRef
  offer: Offer
  /** A Forge slot is needed: one of the free ones, or the next one for sale. */
  slotNeed?: { kind: SlotKind; buy: SlotOffer | null }
  /** Forge level the NFT or slot needs beyond the current one. */
  level: number
  /** Everything in WAX: the NFT, the slot and the Forge level. */
  wax: number
  before: Stats
  after: Stats
  /** places: more mercenaries the division can hold (a warlord with more slots). */
  gain: { tlm: number; atk: number; def: number; move: number; places: number }
  steps: UpgradeStep[]
  /** What it uses up, for spotting two upgrades that cannot both happen. */
  uses: string[]
}

export interface UpgradeInput {
  divisions: Division[]
  missions: MissionEconomics[]
  market: Market
  economy: Economy
  /** Offers by what they are. */
  offers: Record<UpgradeSlot, Offer[]>
  /** Ascensions of pieces in the divisions, by asset id. */
  ascensions: Map<string, Offer>
  /** How many of each resource there are; anything not listed counts as one. */
  capacity: Map<string, number>
}

const SLOT_OF: Partial<Record<GearKind, SlotKind>> = { weapon: 'weapon', supply: 'supply', lavalux: 'lavalux' }
const GEAR: GearKind[] = ['weapon', 'supply', 'creature', 'lavalux']

/** The best TLM per hour a division with these stats earns, on missions that pay in tokens. */
export function rateFor(missions: MissionEconomics[], market: Market, atk: number, def: number, move: number): number {
  let best = 0
  for (const m of missions) {
    if (!meetsRequirements(m, atk, def)) continue
    const r = tlmPerHour(m, move, market)
    if (r > best) best = r
  }
  return best
}

/** A division's stats as the contract adds them up; null if a piece has no known stats. */
export function divisionStats(units: Unit[], leader: AssetRef | null): { atk: number; def: number; move: number } | null {
  let atk = 0
  let def = 0
  let move = 0
  for (const u of units) {
    if (!u.asset.stats) return null
    const t = unitTotals({
      unit: u.asset.stats,
      weapon: u.gear.weapon?.stats,
      supply: u.gear.supply?.stats,
      creature: u.gear.creature?.stats,
      lavalux: u.gear.lavalux?.stats
    })
    atk += t.atk
    def += t.def
    move += t.move
  }
  return { atk, def, move: Math.max(0, move - Number(leader?.stats?.movecost_reduction || 0)) }
}

const sourceStep = (o: Offer): UpgradeStep[] => {
  switch (o.source) {
    case 'reserve':
      return [{ kind: 'owned', label: o.asset.name, detail: 'staked, unused' }]
    case 'wallet':
      return [{ kind: 'owned', label: o.asset.name, detail: 'in wallet' }]
    case 'market':
      return [{ kind: 'market', label: o.asset.name, detail: 'cheapest listing' }]
    case 'blend':
      return [{ kind: 'blend', label: o.asset.name, detail: o.wax > 0 ? 'materials bought' : 'from your materials' }]
    case 'ascend': {
      const a = o.ascend!
      const buy = Math.max(0, a.fragments - a.owned)
      const warlord = kindOfCategory(a.from.stats?.category) === 'warlord'
      return [
        ...(a.staked
          ? [
              {
                kind: 'owned' as const,
                label: `Unstake ${a.from.name}`,
                detail: warlord ? 'empty and disband its division first' : 'take it out first'
              }
            ]
          : []),
        { kind: 'ascend', label: `${a.from.name} one star up`, detail: `${a.fragments} Fragments` },
        ...(a.owned > 0
          ? [{ kind: 'owned' as const, label: `${Math.min(a.owned, a.fragments)} Fragments`, detail: 'in wallet' }]
          : []),
        ...(buy > 0
          ? [
              a.via
                ? {
                    kind: 'market' as const,
                    label: `${Math.ceil(buy / a.via.perCard)} × ${a.via.name}`,
                    detail: `bought, sacrificed for ${buy} Fragments`
                  }
                : { kind: 'market' as const, label: `${buy} Fragments`, detail: 'bought' }
            ]
          : []),
        ...(a.staked
          ? [{ kind: 'owned' as const, label: 'Stake it again', detail: warlord ? 'and rebuild the division' : '' }]
          : [])
      ]
    }
  }
}

/**
 * Every upgrade worth showing. For each place (a gear slot of a mercenary, or a free place in a
 * division) only the best offer is kept by each measure (TLM per hour per WAX, attack per WAX,
 * move per WAX), so the list holds real choices rather than every listing.
 */
export function findUpgrades(input: UpgradeInput): Upgrade[] {
  const { economy, missions, market } = input
  const active = missions.filter((m) => m.state === 'active' && isTokenLoop(m))
  const out: Upgrade[] = []
  const levelWax = (level: number) => (level > economy.forgeLevel ? (economy.levelWax[level] ?? Infinity) : 0)

  for (const d of input.divisions) {
    const base = divisionStats(d.units, d.leader)
    if (!base) continue
    const before: Stats = { ...base, rate: rateFor(active, market, base.atk, base.def, base.move) }

    const consider = (
      place: string,
      slot: UpgradeSlot,
      unit: Unit | undefined,
      replaces: AssetRef | undefined,
      offers: Offer[],
      build: (o: Offer) => { units: Unit[]; leader: AssetRef | null }
    ) => {
      // Best by each measure for this place.
      const best: Record<'tlm' | 'atk' | 'move', { u: Upgrade; score: number } | null> = { tlm: null, atk: null, move: null }
      for (const o of offers) {
        if (replaces && replaces.templateId === o.asset.templateId) continue
        const next = build(o)
        // A new warlord must have room for the troops it takes over.
        if (slot === 'warlord' && Number(next.leader?.stats?.slots_max ?? 0) < d.units.length) continue
        const s = divisionStats(next.units, next.leader)
        if (!s) continue
        const slotKind =
          slot !== 'mercenary' && slot !== 'warlord' && slot !== 'creature' && !replaces ? SLOT_OF[slot] : undefined
        const slotFree = slotKind ? economy.slots[slotKind].free > 0 : false
        const slotBuy = slotKind && !slotFree ? (economy.slots[slotKind].offers[0] ?? null) : null
        if (slotKind && !slotFree && !slotBuy) continue
        const level = Math.max(Number(o.asset.stats?.min_forge_level || 0), slotBuy?.level ?? 0)
        const wax = o.wax + (slotBuy?.wax ?? 0) + levelWax(level)
        if (!Number.isFinite(wax)) continue
        const after: Stats = { ...s, rate: rateFor(active, market, s.atk, s.def, s.move) }
        const gain = {
          tlm: after.rate - before.rate,
          atk: after.atk - before.atk,
          def: after.def - before.def,
          move: before.move - after.move,
          places: Number(next.leader?.stats?.slots_max ?? 0) - Number(d.leader?.stats?.slots_max ?? 0)
        }
        if (gain.tlm <= 1e-9 && gain.atk <= 0 && gain.move <= 0) continue
        const steps: UpgradeStep[] = []
        if (level > economy.forgeLevel) steps.push({ kind: 'forge', label: `Forge level ${level}` })
        if (slotKind && slotBuy)
          steps.push({ kind: 'forge', label: `Unlock ${SLOT_NAME[slotKind]} slot`, detail: `${trim(slotBuy.def)} DEF` })
        steps.push(...sourceStep(o))
        if (slot === 'warlord' && o.source !== 'ascend')
          steps.push({ kind: 'owned', label: 'Move the troops over', detail: `from ${d.leader?.name ?? 'the old warlord'}` })
        const uses = [o.res, `${place}`]
        if (slotKind) uses.push(slotFree ? `slot:${slotKind}` : `slotbuy:${slotKind}`)
        const u: Upgrade = {
          kind: 'single',
          id: `${place}>${o.res}`,
          division: d,
          unit,
          slot,
          replaces,
          offer: o,
          slotNeed: slotKind ? { kind: slotKind, buy: slotBuy } : undefined,
          level,
          wax,
          before,
          after,
          gain,
          steps,
          uses
        }
        const per = (g: number) => (g <= 0 ? -Infinity : wax <= 0 ? 1e12 + g : g / wax)
        for (const [m, g] of [
          ['tlm', gain.tlm],
          ['atk', gain.atk],
          ['move', gain.move]
        ] as const) {
          const score = per(g)
          if (score > -Infinity && (!best[m] || score > best[m]!.score)) best[m] = { u, score }
        }
      }
      const kept = new Set<Upgrade>()
      for (const b of Object.values(best)) if (b) kept.add(b.u)
      out.push(...kept)
    }

    d.units.forEach((unit, i) => {
      const withUnit = (next: Unit) => d.units.map((x, j) => (j === i ? next : x))
      // Gear: every kind, from every source, plus raising the piece that is there a star.
      for (const kind of GEAR) {
        const there = unit.gear[kind]
        const ascend = there ? input.ascensions.get(there.assetId) : undefined
        const offers = ascend ? [...input.offers[kind], ascend] : input.offers[kind]
        consider(`gear:${d.id}:${unit.asset.assetId}:${kind}`, kind, unit, there, offers, (o) => ({
          units: withUnit({ ...unit, gear: { ...unit.gear, [kind]: o.asset } }),
          leader: d.leader
        }))
      }
      // The mercenary itself raised a star.
      const self = input.ascensions.get(unit.asset.assetId)
      if (self)
        consider(`merc:${unit.asset.assetId}`, 'mercenary', unit, unit.asset, [self], (o) => ({
          units: withUnit({ ...unit, asset: o.asset }),
          leader: d.leader
        }))
    })

    // A new mercenary in a free place: bare, its gear can follow as its own upgrades.
    const free = Math.max(0, d.slotsMax - d.units.length)
    if (free > 0)
      consider(`place:${d.id}`, 'mercenary', undefined, undefined, input.offers.mercenary, (o) => ({
        units: [...d.units, { asset: o.asset, gear: {} }],
        leader: d.leader
      }))

    // The warlord: raised a star, or another one leading the same troops.
    if (d.leader) {
      const self = input.ascensions.get(d.leader.assetId)
      const offers = self ? [...input.offers.warlord, self] : input.offers.warlord
      consider(`leader:${d.id}`, 'warlord', undefined, d.leader, offers, (o) => ({ units: d.units, leader: o.asset }))
    }
  }
  return out
}

const SLOT_NAME: Record<SlotKind, string> = { weapon: 'an equipment', supply: 'a supply', lavalux: 'a Lava Lux' }
const trim = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))))

export type Goal = 'tlm' | 'atk' | 'move'

/** What the ranking needs of a row: single upgrades and whole-division plans alike. */
export interface Rankable {
  id: string
  wax: number
  uses: string[]
  gain: { tlm: number; atk: number; move: number }
  steps: UpgradeStep[]
}

export const gainOf = (u: Rankable, goal: Goal) => (goal === 'tlm' ? u.gain.tlm : goal === 'atk' ? u.gain.atk : u.gain.move)

export interface Ranked<T extends Rankable = Upgrade> {
  upgrade: T
  value: number
  /** Set when a better row already uses what this one needs. */
  instead?: T
  /** Totals down to this row, counting only the rows that can all happen together. */
  runWax: number
  runGain: number
}

/**
 * Ranks the upgrades by gain per WAX (free ones first, by gain), then walks down the list:
 * an upgrade that needs something a better one already took (the same place, the same owned NFT,
 * the last free Forge slot) is marked as the alternative to it and left out of the totals.
 */
export function rankUpgrades<T extends Rankable>(list: T[], goal: Goal, capacity: Map<string, number>): Ranked<T>[] {
  const rows = list
    .map((upgrade) => ({ upgrade, value: gainOf(upgrade, goal) }))
    .filter((r) => r.value > 1e-9)
    .sort((a, b) => {
      const fa = a.upgrade.wax <= 0
      const fb = b.upgrade.wax <= 0
      if (fa !== fb) return fa ? -1 : 1
      if (fa) return b.value - a.value
      return b.value / b.upgrade.wax - a.value / a.upgrade.wax || b.value - a.value
    })
  // The same upgrade can be best by two measures: keep it once.
  const seen = new Set<string>()
  const used = new Map<string, number>()
  const takenBy = new Map<string, T>()
  let runWax = 0
  let runGain = 0
  const out: Ranked<T>[] = []
  for (const r of rows) {
    if (seen.has(r.upgrade.id)) continue
    seen.add(r.upgrade.id)
    const clash = r.upgrade.uses.find((k) => (used.get(k) ?? 0) >= (capacity.get(k) ?? 1))
    if (clash) {
      out.push({ ...r, instead: takenBy.get(clash), runWax, runGain })
      continue
    }
    for (const k of r.upgrade.uses) {
      used.set(k, (used.get(k) ?? 0) + 1)
      takenBy.set(k, r.upgrade)
    }
    runWax += r.upgrade.wax
    runGain += r.value
    out.push({ ...r, runWax, runGain })
  }
  return out
}

/** The step kinds an upgrade involves, for the filter chips. */
export const kindsOf = (u: Rankable) => new Set(u.steps.map((s) => s.kind))
