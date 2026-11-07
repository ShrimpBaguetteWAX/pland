import { describe, expect, it } from 'vitest'

import { CATEGORY } from '@/chain/config'
import type { AssetRef } from '@/data/assets'
import type { Division } from '@/data/game'
import type { MissionRow } from '@/data/types'

import { EFFORTS, searchArmy, type SearchInput } from './armySearch'
import { tlmPerHour, type MissionEconomics } from './loop'
import { fallbackMarket } from './market'
import { unitTotals, type Kind } from './stats'

let next = 1
function nft(
  category: number,
  s: Partial<{ atk: number; def: number; move: number; slots: number; red: number; am: number; dm: number; mm: number }>,
  name = ''
): AssetRef {
  const id = String(next++)
  return {
    assetId: id,
    templateId: `t${id}`,
    schema: 'x',
    name: name || `#${id}`,
    rarity: 'common',
    img: '',
    info: null,
    stats: {
      template_id: next,
      category,
      attack: s.atk ?? 0,
      defense: s.def ?? 0,
      movecost: s.move ?? 0,
      movecost_reduction: s.red ?? 0,
      slots_max: s.slots ?? 0,
      attack_mult_bp: s.am ?? 10000,
      defense_mult_bp: s.dm ?? 10000,
      movecost_mult_bp: s.mm ?? 10000,
      min_forge_level: 0,
      image: ''
    }
  }
}

function mission(id: number, minAtk: number, rewardTlm: number, cooldownBase = 3600, minDef = 0): MissionEconomics {
  return {
    mission: { mission_id: id } as unknown as MissionRow,
    id,
    meta: {},
    title: `M${id}`,
    planet: 'x',
    image: '',
    lore: '',
    state: 'active',
    startAt: 0,
    endAt: 0,
    minAtk,
    minDef,
    cooldownBase,
    rewardTlm,
    rewardDef: 0,
    rewardShards: 0,
    rewardNft: null,
    costTlm: 0,
    costDef: 0,
    maxDivisions: 0,
    joined: 0
  } as unknown as MissionEconomics
}

const empty = (): Record<Kind, AssetRef[]> => ({ warlord: [], mercenary: [], weapon: [], supply: [], creature: [], lavalux: [] })
const market = fallbackMarket()
const noSlots = { weapon: 0, supply: 0, lavalux: 0 }

const input = (pool: Record<Kind, AssetRef[]>, missions: MissionEconomics[], extra: Partial<SearchInput> = {}): SearchInput => ({
  pool,
  existing: [],
  missions,
  market,
  forgeLevel: 5,
  slotsFree: noSlots,
  maxDivisions: 20,
  alignMove: false,
  anchors: [],
  budgetMs: 2500,
  ...extra
})

/** A division's numbers added up the contract's way, from the plan's own pairing. */
const recompute = (d: { units: { merc: AssetRef; gear: Partial<Record<Kind, AssetRef>> }[]; warlord: AssetRef }) => {
  let atk = 0
  let def = 0
  let move = 0
  for (const u of d.units) {
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
  return { atk, def, move: Math.max(0, move - Number(d.warlord.stats?.movecost_reduction || 0)) }
}

describe('searchArmy', () => {
  it('fields several small divisions when that earns more than one big one', () => {
    const pool = empty()
    for (let i = 0; i < 3; i++) pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 10 }))
    for (let i = 0; i < 6; i++) pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 50, move: 10 }))
    // One 300-ATK division pays 30; three 100-ATK divisions pay 15 each.
    const result = searchArmy(input(pool, [mission(1, 300, 30), mission(2, 100, 15)]))
    expect(result.divisions).toHaveLength(3)
    expect(result.divisions.every((d) => d.mission.id === 2)).toBe(true)
    expect(result.perHour).toBeCloseTo(3 * tlmPerHour(mission(2, 100, 15), 20, market), 6)
  })

  it('respects the allowance and the warlords there are', () => {
    const pool = empty()
    pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 10 }), nft(CATEGORY.WARLORD, { slots: 10 }))
    for (let i = 0; i < 8; i++) pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 50, move: 5 }))
    expect(searchArmy(input(pool, [mission(1, 50, 10)])).divisions).toHaveLength(2)
    expect(searchArmy(input(pool, [mission(1, 50, 10)], { maxDivisions: 1 })).divisions).toHaveLength(1)
  })

  it('does not starve a later division by greedily taking the best-paying one twice', () => {
    const pool = empty()
    for (let i = 0; i < 3; i++) pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 4 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 100 }), nft(CATEGORY.MERCENARY, { atk: 100 }))
    for (let i = 0; i < 4; i++) pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 50 }))
    // Greedy: two 200s (the 100s and the 50s pair up) = 40, nothing left. Best: one 200 + two 100s = 20 + 24 = 44.
    const result = searchArmy(input(pool, [mission(1, 200, 20), mission(2, 100, 12)]))
    expect(result.perHour).toBeCloseTo(44, 6)
  })

  it('puts the gear where it lets one more division meet a mission', () => {
    const pool = empty()
    pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 3 }), nft(CATEGORY.WARLORD, { slots: 3 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 90 }), nft(CATEGORY.MERCENARY, { atk: 90 }))
    pool.weapon.push(nft(CATEGORY.WEAPON, { atk: 10 }), nft(CATEGORY.WEAPON, { atk: 10 }))
    const result = searchArmy(input(pool, [mission(1, 100, 10)], { slotsFree: { weapon: 2, supply: 0, lavalux: 0 } }))
    expect(result.divisions).toHaveLength(2)
    expect(result.divisions.every((d) => d.units[0].gear.weapon)).toBe(true)
    // Only one weapon slot: only one division can be made.
    const one = searchArmy(input(pool, [mission(1, 100, 10)], { slotsFree: { weapon: 1, supply: 0, lavalux: 0 } }))
    expect(one.divisions).toHaveLength(1)
  })

  it('uses supplies, Lava Lux and warlord reductions the way the contract does, and never proposes a division that fails', () => {
    const pool = empty()
    pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 6, red: 15 }), nft(CATEGORY.WARLORD, { slots: 6 }), nft(CATEGORY.WARLORD, { slots: 2 }))
    for (let i = 0; i < 9; i++) pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 40 + i * 7, def: 30 + i * 5, move: 20 + i }))
    pool.weapon.push(nft(CATEGORY.WEAPON, { atk: 30, def: 10 }), nft(CATEGORY.WEAPON, { atk: 5, def: 25 }))
    pool.supply.push(nft(CATEGORY.SUPPLY, { atk: 5, def: 5, red: 12 }), nft(CATEGORY.SUPPLY, { red: 30 }))
    pool.creature.push(nft(CATEGORY.CREATURE, { atk: 20, def: 20 }))
    pool.lavalux.push(nft(CATEGORY.LAVALUX, { am: 13000, dm: 13000, mm: 12000 }))
    const missions = [mission(1, 150, 20, 1800, 100), mission(2, 300, 50, 3600, 200), mission(3, 80, 6, 900)]
    const result = searchArmy(input(pool, missions, { slotsFree: { weapon: 2, supply: 2, lavalux: 1 } }))
    expect(result.warnings).toEqual([])
    expect(result.divisions.length).toBeGreaterThan(0)
    for (const d of result.divisions) {
      expect(recompute(d)).toEqual({ atk: d.atk, def: d.def, move: d.move })
      expect(d.atk).toBeGreaterThanOrEqual(d.mission.minAtk)
      expect(d.def).toBeGreaterThanOrEqual(d.mission.minDef)
      expect(d.units.length).toBeLessThanOrEqual(Number(d.warlord.stats!.slots_max))
    }
    const ids = result.divisions.flatMap((d) => [d.warlord.assetId, ...d.units.flatMap((u) => [u.merc.assetId, ...Object.values(u.gear).map((g) => g!.assetId)])])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives the same answer for the same army', () => {
    const pool = empty()
    for (let i = 0; i < 4; i++) pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 5 }))
    for (let i = 0; i < 14; i++) pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 30 + ((i * 17) % 60), move: 10 + (i % 7) }))
    const missions = [mission(1, 120, 12), mission(2, 60, 7, 1800)]
    const a = searchArmy(input(pool, missions, { budgetMs: 2000 }))
    const b = searchArmy(input(pool, missions, { budgetMs: 2000 }))
    expect(b.perHour).toBeCloseTo(a.perHour, 9)
    expect(b.divisions.map((d) => d.warlord.assetId)).toEqual(a.divisions.map((d) => d.warlord.assetId))
  })

  it('with the work counted, gives exactly the same army for the same input and seed, whatever the clock', () => {
    const pool = empty()
    for (let i = 0; i < 6; i++) pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 6 + (i % 3) * 2, red: (i % 2) * 10 }))
    for (let i = 0; i < 30; i++) pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 20 + ((i * 37) % 90), def: 10 + ((i * 23) % 60), move: 8 + ((i * 11) % 30) }))
    for (let i = 0; i < 6; i++) pool.supply.push(nft(CATEGORY.SUPPLY, { atk: 10, def: 10, red: 6 + i }))
    const missions = [mission(1, 150, 15), mission(2, 300, 40, 3600, 100), mission(3, 80, 5, 1800)]
    const run = (seed: number) => searchArmy(input(pool, missions, { effort: { ...EFFORTS.quick, rounds: 1, balanceTurns: 2 }, seed, alignMove: true, slotsFree: { weapon: 0, supply: 4, lavalux: 0 } }))
    const sig = (r: ReturnType<typeof run>) => JSON.stringify([r.divisions.map((d) => [d.warlord.assetId, d.units.map((u) => [u.merc.assetId, ...Object.values(u.gear).map((g) => g!.assetId)])]), r.balanced?.divisions.map((d) => d.units.length)])
    const a = run(3)
    const b = run(3)
    expect(sig(b)).toBe(sig(a))
    expect(b.perHour).toBe(a.perHour)
    expect(b.score).toBe(a.score)
  })

  it('is never worse than the army as it stands, and keeps a division that is already right', () => {
    const w = nft(CATEGORY.WARLORD, { slots: 4 })
    const m1 = nft(CATEGORY.MERCENARY, { atk: 60, move: 5 })
    const m2 = nft(CATEGORY.MERCENARY, { atk: 60, move: 5 })
    const pool = empty()
    pool.warlord.push(w)
    pool.mercenary.push(m1, m2)
    const existing = [
      { id: 9, leader: w, units: [{ asset: m1, gear: {} }, { asset: m2, gear: {} }], slotsMax: 4, atk: 120, def: 0, move: 10 } as unknown as Division
    ]
    const result = searchArmy(input(pool, [mission(1, 100, 10)], { existing }))
    expect(result.perHour).toBeGreaterThanOrEqual(result.nowPerHour - 1e-9)
    expect(result.divisions).toHaveLength(1)
    expect(result.divisions[0].existingId).toBe(9)
    expect(result.divisions[0].unchanged).toBe(true)
  })

  it('with move-matching, gives a second answer with divisions of one length close, each valued at its own move', () => {
    const pool = empty()
    pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 3 }), nft(CATEGORY.WARLORD, { slots: 3 }))
    // Two quick and two slow mercenaries of the same strength: paired quick+slow the two divisions match.
    pool.mercenary.push(
      nft(CATEGORY.MERCENARY, { atk: 50, move: 5 }),
      nft(CATEGORY.MERCENARY, { atk: 50, move: 5 }),
      nft(CATEGORY.MERCENARY, { atk: 50, move: 40 }),
      nft(CATEGORY.MERCENARY, { atk: 50, move: 40 })
    )
    const result = searchArmy(input(pool, [mission(1, 100, 10)], { alignMove: true }))
    expect(result.divisions).toHaveLength(2)
    expect(result.balanced).toBeDefined()
    expect(result.balanced!.divisions).toHaveLength(2)
    const moves = result.balanced!.divisions.map((d) => d.move)
    expect(Math.max(...moves) - Math.min(...moves)).toBeLessThanOrEqual(30)
    expect(result.balanced!.divisions.every((d) => d.pace === d.move)).toBe(true)
  })

  it('keeps the balance the army already has when the best answer cannot be balanced as well', () => {
    const w1 = nft(CATEGORY.WARLORD, { slots: 1 })
    const w2 = nft(CATEGORY.WARLORD, { slots: 1 })
    const a = nft(CATEGORY.MERCENARY, { atk: 100, move: 30 })
    const b = nft(CATEGORY.MERCENARY, { atk: 100, move: 30 })
    const q = nft(CATEGORY.MERCENARY, { atk: 100, move: 5 })
    const pool = empty()
    pool.warlord.push(w1, w2)
    pool.mercenary.push(a, b, q)
    // Two divisions at 30 move stand; the quick card earns more in one of them (9.86 against 9.23 an
    // hour) but puts the two 25 apart, which under the default sliders costs more than it brings.
    const existing = [
      { id: 1, leader: w1, units: [{ asset: a, gear: {} }], slotsMax: 1, atk: 100, def: 0, move: 30 },
      { id: 2, leader: w2, units: [{ asset: b, gear: {} }], slotsMax: 1, atk: 100, def: 0, move: 30 }
    ] as unknown as Division[]
    const result = searchArmy(input(pool, [mission(1, 100, 10)], { existing, alignMove: true, budgetMs: 4000 }))
    expect(result.divisions.map((d) => d.move).sort()).toEqual([30, 5])
    expect(result.balanced!.divisions.map((d) => d.move)).toEqual([30, 30])
    expect(result.balanced!.perHour).toBeCloseTo(2 * tlmPerHour(mission(1, 100, 10), 30, market), 6)
  })

  it('draws a new division towards one that stays out on a mission of the same length', () => {
    const pool = empty()
    pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 3 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 100, move: 5 }), nft(CATEGORY.MERCENARY, { atk: 100, move: 60 }))
    // The best answer takes the quick one (9.9 against 8.6 an hour). Next to a division out at 60 move,
    // the quick one is 55 points apart: the balanced answer takes the slow one instead.
    const alone = searchArmy(input(pool, [mission(1, 100, 10)], { alignMove: true, anchors: [{ cooldownBase: 3600, move: 60 }] }))
    expect(alone.divisions).toHaveLength(1)
    expect(alone.divisions[0].move).toBe(5)
    expect(alone.balanced!.divisions).toHaveLength(1)
    expect(alone.balanced!.divisions[0].move).toBe(60)
    expect(alone.balanced!.divisions[0].perHour).toBeCloseTo(tlmPerHour(mission(1, 100, 10), 60, market), 6)
  })

  it('finishes inside its budget on a big army', () => {
    const pool = empty()
    for (let i = 0; i < 20; i++) pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 10 + (i % 4) * 12, red: (i % 3) * 20 }))
    for (let i = 0; i < 220; i++)
      pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 20 + ((i * 37) % 140), def: 20 + ((i * 53) % 140), move: 15 + ((i * 11) % 45) }))
    for (let i = 0; i < 20; i++) pool.weapon.push(nft(CATEGORY.WEAPON, { atk: 10 + i * 6, def: 5 + i * 5 }))
    for (let i = 0; i < 6; i++) pool.supply.push(nft(CATEGORY.SUPPLY, { atk: 10, def: 10, red: 10 + i * 5 }))
    for (let i = 0; i < 4; i++) pool.lavalux.push(nft(CATEGORY.LAVALUX, { am: 11600 + i * 1500, dm: 11600 + i * 1500, mm: 11000 + i * 500 }))
    const missions = [
      mission(1, 30, 1, 3600),
      mission(2, 100, 5, 3600),
      mission(3, 350, 20, 3600),
      mission(4, 700, 200, 3600),
      mission(5, 1000, 70, 7200),
      mission(6, 2000, 1400, 7200),
      mission(7, 5000, 7000, 14400),
      mission(8, 500, 40, 3600, 300)
    ]
    const started = Date.now()
    const result = searchArmy(input(pool, missions, { budgetMs: 6000, slotsFree: { weapon: 15, supply: 4, lavalux: 4 } }))
    expect(Date.now() - started).toBeLessThan(9000)
    expect(result.warnings).toEqual([])
    expect(result.divisions.length).toBeGreaterThan(5)
    expect(result.moves).toBeGreaterThan(50_000)
    for (const d of result.divisions) expect(recompute(d)).toEqual({ atk: d.atk, def: d.def, move: d.move })
  })
})

describe('taking a big division apart', () => {
  it('turns one big division into several medium ones when they earn more together', () => {
    // One 5 200-attack division on a 5 000 mission (6 h base) versus two 2 000-attack ones on a
    // 2 h mission that pays well: the two earn more, but no single-card change gets there.
    const big = nft(CATEGORY.WARLORD, { slots: 53 })
    const spare = [nft(CATEGORY.WARLORD, { slots: 29 }), nft(CATEGORY.WARLORD, { slots: 29 })]
    const mercs = Array.from({ length: 40 }, () => nft(CATEGORY.MERCENARY, { atk: 130, move: 20 }))
    const pool = empty()
    pool.warlord.push(big, ...spare)
    pool.mercenary.push(...mercs)
    const existing = [
      { id: 1, leader: big, units: mercs.map((asset) => ({ asset, gear: {} })), slotsMax: 53, atk: 5200, def: 0, move: 800 } as unknown as Division
    ]
    const neri = mission(1, 5000, 1820, 21600)
    const veles = mission(2, 2000, 600, 7200)
    const result = searchArmy(input(pool, [neri, veles], { existing, budgetMs: 4000 }))
    // Two divisions of 16 mercenaries (2 080 atk, 320 move) on the 2 h mission: 207.7 each.
    const onVeles = result.divisions.filter((d) => d.mission.id === 2)
    expect(onVeles.length).toBeGreaterThanOrEqual(2)
    expect(result.perHour).toBeGreaterThan(400)
    expect(result.perHour).toBeGreaterThan(result.nowPerHour)
  })

  it('values an existing division by its own gear pairing until it changes', () => {
    // The player put the Lava Lux on the weaker mercenary; the search would put it on the stronger
    // one. As it stands, the division is worth what it really is, not what a re-deal would make it.
    const w = nft(CATEGORY.WARLORD, { slots: 4 })
    const strong = nft(CATEGORY.MERCENARY, { atk: 80, move: 10 })
    const weak = nft(CATEGORY.MERCENARY, { atk: 40, move: 10 })
    const lava = nft(CATEGORY.LAVALUX, { am: 15000, dm: 15000, mm: 10000 })
    const pool = empty()
    pool.warlord.push(w)
    pool.mercenary.push(strong, weak)
    pool.lavalux.push(lava)
    const existing = [
      { id: 3, leader: w, units: [{ asset: strong, gear: {} }, { asset: weak, gear: { lavalux: lava } }], slotsMax: 4, atk: 140, def: 0, move: 20 } as unknown as Division
    ]
    // Needs 150: as paired it has 80 + 60 = 140 and meets nothing; re-dealt it has 120 + 40 = 160.
    const m = mission(1, 150, 10)
    const result = searchArmy(input(pool, [m], { existing, slotsFree: { weapon: 0, supply: 0, lavalux: 1 }, budgetMs: 2000 }))
    expect(result.nowPerHour).toBe(0)
    expect(result.divisions).toHaveLength(1)
    expect(result.divisions[0].units.find((u) => u.merc.assetId === strong.assetId)?.gear.lavalux?.assetId).toBe(lava.assetId)
    expect(result.divisions[0].unchanged).toBe(false)
  })
})

describe('how many divisions of a mission the cards can field', () => {
  it('never reports fewer than the army already fields, and finds the count a tight army allows', () => {
    // Four warlords, 64 mercenaries of 125 attack: exactly four 2 000-attack divisions, nothing to spare.
    const warlords = Array.from({ length: 4 }, () => nft(CATEGORY.WARLORD, { slots: 16 }))
    const mercs = Array.from({ length: 64 }, () => nft(CATEGORY.MERCENARY, { atk: 125, move: 10 }))
    const pool = empty()
    pool.warlord.push(...warlords)
    pool.mercenary.push(...mercs)
    const veles = mission(2, 2000, 600, 7200)
    const result = searchArmy(input(pool, [veles, mission(1, 5000, 1820, 21600)], { budgetMs: 4000 }))
    expect(result.tried.find((t) => t.mission.id === 2)?.count).toBe(4)
    expect(result.divisions.filter((d) => d.mission.id === 2)).toHaveLength(4)
    // The same army already arranged that way: the floor says four even before any packing.
    const existing = warlords.map(
      (w, i) => ({ id: i + 1, leader: w, units: mercs.slice(i * 16, i * 16 + 16).map((asset) => ({ asset, gear: {} })), slotsMax: 16, atk: 2000, def: 0, move: 160 }) as unknown as Division
    )
    const again = searchArmy(input(pool, [veles], { existing, budgetMs: 2500 }))
    expect(again.tried.find((t) => t.mission.id === 2)?.count).toBeGreaterThanOrEqual(4)
    expect(again.perHour).toBeCloseTo(again.nowPerHour, 6)
  })
})

describe('a count the army almost fields', () => {
  it('finds the fourth division when one existing division is a point short and the pool has the card', () => {
    const warlords = Array.from({ length: 4 }, () => nft(CATEGORY.WARLORD, { slots: 20 }))
    // Three divisions at exactly 2 000, one at 1 999, and a single 23-attack recruit in the reserve.
    const strong = Array.from({ length: 48 }, () => nft(CATEGORY.MERCENARY, { atk: 125, move: 10 }))
    const weak = Array.from({ length: 16 }, (_, i) => nft(CATEGORY.MERCENARY, { atk: i === 0 ? 124 : 125, move: 10 }))
    const spare = nft(CATEGORY.MERCENARY, { atk: 23, move: 15 })
    const pool = empty()
    pool.warlord.push(...warlords)
    pool.mercenary.push(...strong, ...weak, spare)
    const existing = [
      ...[0, 1, 2].map((i) => ({ id: i + 1, leader: warlords[i], units: strong.slice(i * 16, i * 16 + 16).map((asset) => ({ asset, gear: {} })), slotsMax: 20, atk: 2000, def: 0, move: 160 }) as unknown as Division),
      { id: 4, leader: warlords[3], units: weak.map((asset) => ({ asset, gear: {} })), slotsMax: 20, atk: 1999, def: 0, move: 160 } as unknown as Division
    ]
    const veles = mission(2, 2000, 600, 7200)
    const result = searchArmy(input(pool, [veles, mission(1, 100, 2, 1800)], { existing, budgetMs: 4000 }))
    expect(result.tried.find((t) => t.mission.id === 2)?.count).toBe(4)
    expect(result.divisions.filter((d) => d.mission.id === 2)).toHaveLength(4)
  })
})
