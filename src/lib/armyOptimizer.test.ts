import { describe, expect, it } from 'vitest'

import { CATEGORY } from '@/chain/config'
import type { AssetRef } from '@/data/assets'
import type { MissionRow } from '@/data/types'

import { bestLoop, candidateMissions, optimizeArmy, packDivisions, tightestSubset, tightestWithinCut } from './armyOptimizer'
import { tlmPerHour, type MissionEconomics } from './loop'
import { fallbackMarket } from './market'
import type { Kind } from './stats'

let next = 1
function nft(category: number, s: Partial<{ atk: number; def: number; move: number; slots: number }>, name = ''): AssetRef {
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
      movecost_reduction: 0,
      slots_max: s.slots ?? 0,
      attack_mult_bp: 10000,
      defense_mult_bp: 10000,
      movecost_mult_bp: 10000,
      min_forge_level: 0,
      image: ''
    }
  }
}

function mission(id: number, minAtk: number, rewardTlm: number, cooldownBase = 3600): MissionEconomics {
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
    minDef: 0,
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

describe('optimizeArmy', () => {
  it('fields several small divisions when that earns more than one big one', () => {
    const pool = empty()
    for (let i = 0; i < 3; i++) pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 6 }))
    for (let i = 0; i < 6; i++) pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 100, move: 10 }))
    // One 600 ATK mission pays 50 TLM an hour; a 100 ATK mission pays 30: three of those beat it.
    const missions = [mission(1, 600, 50), mission(2, 100, 30)]
    const plan = optimizeArmy({ pool, missions, market, forgeLevel: 0, slotsFree: noSlots, maxDivisions: 3 })
    expect(plan.divisions).toHaveLength(3)
    expect(plan.divisions.every((d) => d.mission.id === 2)).toBe(true)
    expect(plan.perHour).toBeGreaterThan(50)
    // Every NFT is used at most once.
    const ids = plan.divisions.flatMap((d) => {
      const b = d.plan.bundle
      return [b.warlord.key, ...b.mercs.map((m) => m.key), ...b.gear.weapon.map((g) => g.key)]
    })
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('respects the division allowance and stops when warlords run out', () => {
    const pool = empty()
    pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 3 }), nft(CATEGORY.WARLORD, { slots: 3 }))
    for (let i = 0; i < 6; i++) pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 50, move: 10 }))
    const missions = [mission(1, 50, 10)]
    expect(optimizeArmy({ pool, missions, market, forgeLevel: 0, slotsFree: noSlots, maxDivisions: 1 }).divisions).toHaveLength(1)
    expect(optimizeArmy({ pool, missions, market, forgeLevel: 0, slotsFree: noSlots, maxDivisions: 5 }).divisions).toHaveLength(2)
  })

  it('prefers the mission that pays more per hour for the same division', () => {
    const pool = empty()
    pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 2 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 200, move: 10 }))
    const missions = [mission(1, 100, 10), mission(2, 100, 20)]
    const plan = optimizeArmy({ pool, missions, market, forgeLevel: 0, slotsFree: noSlots, maxDivisions: 3 })
    expect(plan.divisions[0].mission.id).toBe(2)
    expect(bestLoop({ atk: 200, def: 0, move: 10 }, missions, market)?.mission.id).toBe(2)
  })

  it('keeps one candidate per distinct requirement and pay', () => {
    expect(candidateMissions([mission(1, 100, 10), mission(2, 100, 10), mission(3, 200, 10)])).toHaveLength(2)
  })
})

describe('beam search', () => {
  it('does not starve a later division by taking the best-paying next one twice', () => {
    // Two strong and four weak mercenaries, three warlords. A 200 ATK mission pays 10 an hour, a
    // 100 ATK mission 6. Greedy takes 200 twice (strong + weak×3, then nothing is left for a third
    // division); one 200 and two 100s earn more.
    const pool = empty()
    for (let i = 0; i < 3; i++) pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 6 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 110, move: 10 }), nft(CATEGORY.MERCENARY, { atk: 110, move: 10 }))
    for (let i = 0; i < 4; i++) pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 50, move: 10 }))
    const missions = [mission(1, 200, 10, 3600), mission(2, 100, 6, 3600)]
    const plan = optimizeArmy({ pool, missions, market, forgeLevel: 0, slotsFree: noSlots, maxDivisions: 3 })
    expect(plan.divisions).toHaveLength(3)
    expect(plan.divisions.filter((d) => d.mission.id === 1)).toHaveLength(1)
  })
})

describe('existing divisions', () => {
  it('keeps a division as it is when nothing planned beats it, and never proposes less', () => {
    // A single mercenary with a weapon reaches the 200 ATK mission; the planner alone would pick
    // the same NFTs, so the answer is the existing division, kept, and the plan is never worse.
    const warlord = nft(CATEGORY.WARLORD, { slots: 1 })
    const merc = nft(CATEGORY.MERCENARY, { atk: 150, move: 10 })
    const weapon = nft(CATEGORY.WEAPON, { atk: 60 })
    const division = {
      id: 7,
      leader: warlord,
      units: [{ asset: merc, gear: { weapon } }],
      slotsMax: 1,
      atk: 210,
      def: 0,
      move: 10,
      lock: null
    } as unknown as import('@/data/game').Division
    const pool = empty()
    pool.warlord.push(warlord)
    pool.mercenary.push(merc)
    pool.weapon.push(weapon)
    const missions = [mission(1, 200, 10), mission(2, 100, 6)]
    const plan = optimizeArmy({
      pool,
      missions,
      market,
      forgeLevel: 0,
      slotsFree: { weapon: 1, supply: 0, lavalux: 0 },
      maxDivisions: 3,
      existing: [division]
    })
    expect(plan.divisions).toHaveLength(1)
    expect(plan.divisions[0].existingId).toBe(7)
    expect(plan.perHour).toBeCloseTo(bestLoop(division, missions, market)!.perHour, 6)
  })
})

describe('alignMove', () => {
  it('values divisions on missions of the same length at the pace of the slowest, and keeps them close', () => {
    const pool = empty()
    for (let i = 0; i < 2; i++) pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 1 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 100, move: 10 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 100, move: 50 }))
    const missions = [mission(1, 100, 10)]
    const loose = optimizeArmy({ pool, missions, market, forgeLevel: 0, slotsFree: noSlots, maxDivisions: 2 })
    const aligned = optimizeArmy({ pool, missions, market, forgeLevel: 0, slotsFree: noSlots, maxDivisions: 2, alignMove: true })
    expect(loose.divisions).toHaveLength(2)
    // Each division is rated at its group's slowest move, so the aligned army never claims more than the loose one.
    expect(aligned.perHour).toBeLessThanOrEqual(loose.perHour + 1e-9)
    const slowest = Math.max(...aligned.divisions.map((d) => d.plan.bundle.move))
    for (const d of aligned.divisions) expect(d.perHour).toBeCloseTo(tlmPerHour(d.mission, slowest, market), 9)
  })
})

describe('balanceMoves', () => {
  it('trades units between divisions of the same length until their move costs are close', () => {
    const pool = empty()
    for (let i = 0; i < 2; i++) pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 2 }))
    // Two slow and two quick mercenaries of equal strength: a 150 ATK mission needs two each.
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 80, move: 40 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 80, move: 40 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 80, move: 5 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 80, move: 5 }))
    const missions = [mission(1, 150, 10)]
    const aligned = optimizeArmy({ pool, missions, market, forgeLevel: 0, slotsFree: noSlots, maxDivisions: 2, alignMove: true })
    expect(aligned.divisions).toHaveLength(2)
    const moves = aligned.divisions.map((d) => d.plan.bundle.move)
    // (40 + 5) each, not (5 + 5) and (40 + 40).
    expect(Math.abs(moves[0] - moves[1])).toBeLessThanOrEqual(3)
    for (const d of aligned.divisions) {
      expect(d.plan.bundle.atk).toBeGreaterThanOrEqual(150)
      expect(d.plan.bundle.mercs).toHaveLength(2)
    }
  })
})

describe('balanceMoves with the pool', () => {
  it('swaps a slow mercenary for an unused one nearer the others', () => {
    const pool = empty()
    for (let i = 0; i < 2; i++) pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 1 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 100, move: 31 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 100, move: 44 }))
    // Unused: stronger, so the planner leaves it, but its move matches the quick one.
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 130, move: 32 }))
    const missions = [mission(1, 100, 10)]
    const aligned = optimizeArmy({ pool, missions, market, forgeLevel: 0, slotsFree: noSlots, maxDivisions: 2, alignMove: true })
    expect(aligned.divisions).toHaveLength(2)
    const moves = aligned.divisions.map((d) => d.plan.bundle.move).sort((a, b) => a - b)
    expect(moves[1] - moves[0]).toBeLessThanOrEqual(3)
  })

  it('gives the slowest division an unused supply when a Forge slot is free', () => {
    const pool = empty()
    for (let i = 0; i < 2; i++) pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 1 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 100, move: 30 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 100, move: 42 }))
    const supply = nft(CATEGORY.SUPPLY, { atk: 0, def: 0, move: 0 })
    supply.stats!.movecost_reduction = 12
    pool.supply.push(supply)
    const missions = [mission(1, 100, 10)]
    const aligned = optimizeArmy({
      pool,
      missions,
      market,
      forgeLevel: 0,
      slotsFree: { weapon: 0, supply: 1, lavalux: 0 },
      maxDivisions: 2,
      alignMove: true
    })
    const moves = aligned.divisions.map((d) => d.plan.bundle.move).sort((a, b) => a - b)
    expect(moves[1] - moves[0]).toBeLessThanOrEqual(3)
  })
})

describe('anchors', () => {
  it('draws a new division towards a division that stays out on a mission of the same length', () => {
    const pool = empty()
    pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 1 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 100, move: 20 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 120, move: 58 }))
    const missions = [mission(1, 100, 10)]
    // Alone, the planner takes the quick mercenary (move 20). A division out at move 60 pulls it to 58.
    const plan = optimizeArmy({
      pool,
      missions,
      market,
      forgeLevel: 0,
      slotsFree: noSlots,
      maxDivisions: 1,
      alignMove: true,
      anchors: [{ cooldownBase: 3600, move: 60 }]
    })
    expect(plan.divisions).toHaveLength(1)
    expect(plan.divisions[0].plan.bundle.move).toBe(58)
    // And it is valued at the pace of the slowest of the two.
    expect(plan.divisions[0].perHour).toBeCloseTo(tlmPerHour(missions[0], 60, market), 9)
  })
})

describe('replanning a group', () => {
  it('meets in the middle instead of raising the quick division to the slow one', () => {
    const pool = empty()
    for (let i = 0; i < 2; i++) pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 2 }))
    // Equal strength, so the planner would first field the two quick ones together (20) and leave the slow pair (100).
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 100, move: 50 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 100, move: 50 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 100, move: 10 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 100, move: 10 }))
    const missions = [mission(1, 200, 10)]
    const plan = optimizeArmy({ pool, missions, market, forgeLevel: 0, slotsFree: noSlots, maxDivisions: 2, alignMove: true })
    expect(plan.divisions).toHaveLength(2)
    const moves = plan.divisions.map((d) => d.plan.bundle.move)
    expect(moves).toEqual([60, 60])
    for (const d of plan.divisions) expect(d.plan.bundle.atk).toBeGreaterThanOrEqual(200)
  })
})

describe('packing divisions of one mission', () => {
  it('finds the set that clears a target with the least to spare', () => {
    const picked = tightestSubset([900, 600, 450, 300, 120], 1000, 5)!
    expect(picked.reduce((n, i) => n + [900, 600, 450, 300, 120][i], 0)).toBe(1020)
    expect(tightestSubset([100, 100], 1000, 5)).toBeNull()
    expect(tightestSubset([600, 600], 1000, 1)).toBeNull()
  })

  it('takes as much move as the warlord cancels, within a little spare strength', () => {
    const values = [1000, 500, 500, 30, 30]
    const moves = [40, 10, 10, 15, 15]
    const picked = tightestWithinCut(values, moves, 1000, 40, 60)!
    // 1000 alone moves 40; 500 + 500 moves 20, so the warlord's cut is used by the first.
    expect(picked.reduce((n, i) => n + moves[i], 0)).toBe(40)
    expect(picked.reduce((n, i) => n + values[i], 0)).toBeGreaterThanOrEqual(1000)
    // Nothing clears the target without going over the cut.
    expect(tightestWithinCut([1000], [50], 1000, 40, 10)).toBeNull()
  })

  it("counts the warlord's move reduction and spreads slow units so no division keeps any move", () => {
    const pool = empty()
    for (let i = 0; i < 2; i++) {
      const w = nft(CATEGORY.WARLORD, { slots: 10 })
      w.stats!.movecost_reduction = 30
      pool.warlord.push(w)
    }
    // Two strong units with no move, and six weak ones that move 10 each.
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 90 }), nft(CATEGORY.MERCENARY, { atk: 90 }))
    for (let i = 0; i < 6; i++) pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 10, move: 10 }))
    const plans = packDivisions(pool, mission(1, 120, 10), 2, noSlots, 0)!
    expect(plans).toHaveLength(2)
    for (const p of plans) {
      expect(p.bundle.atk).toBeGreaterThanOrEqual(120)
      expect(p.bundle.move).toBe(0)
    }
  })
})
