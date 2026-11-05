import { describe, expect, it } from 'vitest'

import { solveBundle, type Candidate, type SolveInput, type WarlordOption } from './bundle'
import { bruteForce, economy, merc, rng } from './bundle.testkit'

function randomInput(seed: number, bothStats: boolean): SolveInput {
  const r = rng(seed)
  const items: Candidate[] = []
  const kinds = ['mercenary', 'mercenary', 'mercenary', 'weapon', 'supply', 'creature'] as const
  for (let i = 0; i < 9; i++) {
    const kind = kinds[Math.floor(r() * kinds.length)]
    items.push({
      key: `i${i}`,
      kind,
      // Listings of one template share its stats, so every random item is its own template.
      group: `t${i}`,
      atk: Math.floor(r() * 60) + 1,
      def: Math.floor(r() * 60) + 1,
      move: 20,
      moveReduction: kind === 'supply' ? 5 : 0,
      minLevel: 0,
      cost: Math.floor(r() * 90) + 10
    })
  }
  const warlords: WarlordOption[] = [
    { key: 'w1', slots: 1, minLevel: 0, cost: Math.floor(r() * 30) },
    { key: 'w2', slots: 3, minLevel: 0, cost: Math.floor(r() * 80) + 20 }
  ]
  return {
    atk: Math.floor(r() * 120) + 20,
    def: bothStats ? Math.floor(r() * 120) + 20 : 0,
    warlords,
    items,
    economy: economy({ weapon: Math.floor(r() * 2), supply: 0, lavalux: 0 }, Math.floor(r() * 40) + 5, Math.floor(r() * 60) + 10)
  }
}

describe('solveBundle', () => {
  it('finds the true cheapest bundle, Forge slots and level included, when one stat matters', () => {
    for (let seed = 1; seed <= 80; seed++) {
      const input = randomInput(seed, false)
      const expected = bruteForce(input)
      const got = solveBundle(input)
      if (!Number.isFinite(expected)) expect(got).toBeNull()
      else expect(got?.cost, `seed ${seed}`).toBeCloseTo(expected, 6)
    }
  })

  it('always meets both targets and the division rules, close to the optimum', () => {
    let worst = 0
    for (let seed = 100; seed <= 180; seed++) {
      const input = randomInput(seed, true)
      const expected = bruteForce(input)
      const got = solveBundle(input)
      if (!Number.isFinite(expected)) {
        expect(got).toBeNull()
        continue
      }
      expect(got, `seed ${seed}`).not.toBeNull()
      expect(got!.atk).toBeGreaterThanOrEqual(input.atk)
      expect(got!.def).toBeGreaterThanOrEqual(input.def)
      expect(got!.mercs.length).toBeLessThanOrEqual(got!.warlord.slots)
      for (const k of ['weapon', 'supply', 'creature'] as const)
        expect(got!.gear[k].length).toBeLessThanOrEqual(got!.mercs.length)
      worst = Math.max(worst, got!.cost / expected - 1)
    }
    expect(worst).toBeLessThan(0.1)
  })

  it('uses owned items (cost 0) before buying', () => {
    const input: SolveInput = {
      atk: 100,
      def: 0,
      warlords: [{ key: 'mine', slots: 2, minLevel: 0, cost: 0 }],
      items: [merc('owned', 60, 0, 0), merc('cheap', 50, 0, 5), merc('dear', 120, 0, 50)],
      economy: economy({ weapon: 0, supply: 0, lavalux: 0 }, 10, 100)
    }
    const b = solveBundle(input)!
    expect(b.cost).toBe(5)
    expect(b.mercs.map((m) => m.key).sort()).toEqual(['cheap', 'owned'])
  })

  it('buys a Forge slot when equipment is the cheaper way', () => {
    const rifle = (key: string): Candidate => ({ ...merc(key, 50, 0, 2), kind: 'weapon' })
    const input: SolveInput = {
      atk: 110,
      def: 0,
      // Only one mercenary fits: the rest has to come from gear.
      warlords: [{ key: 'one', slots: 1, minLevel: 0, cost: 0 }],
      items: [merc('m', 60, 0, 10), merc('big', 110, 0, 500), rifle('r1'), rifle('r2')],
      economy: economy({ weapon: 0, supply: 0, lavalux: 0 }, 20, 50)
    }
    const b = solveBundle(input)!
    // merc 10 + rifle 2 + the first equipment slot 20 WAX = 32, far below the 500 WAX mercenary.
    expect(b.cost).toBe(32)
    expect(b.slotsBought.weapon).toHaveLength(1)
    expect(b.level).toBe(0)
  })

  it('pays for the next Forge level when the slot behind it is worth it', () => {
    const rifle = (key: string): Candidate => ({ ...merc(key, 50, 0, 2), kind: 'weapon' })
    const input: SolveInput = {
      atk: 160,
      def: 0,
      warlords: [{ key: 'two', slots: 2, minLevel: 0, cost: 0 }],
      items: [merc('m1', 30, 0, 10), merc('m2', 30, 0, 10), merc('big', 160, 0, 900), rifle('r1'), rifle('r2')],
      // Two rifles need two slots: the second one is only sold at Forge level 1.
      economy: economy({ weapon: 0, supply: 0, lavalux: 0 }, 20, 50)
    }
    const b = solveBundle(input)!
    // mercs 20 + rifles 4 + slots 20 + 40 + level 1 for 50 = 134.
    expect(b.cost).toBe(134)
    expect(b.level).toBe(1)
    expect(b.forgeCost).toBe(50)
  })

  it('adds a Lava Lux pass when multiplying beats buying more', () => {
    const lava: Candidate = { ...merc('lava', 0, 0, 5), kind: 'lavalux', atkMult: 1.5, defMult: 1.5, moveMult: 1.2 }
    const input: SolveInput = {
      atk: 150,
      def: 0,
      warlords: [{ key: 'two', slots: 2, minLevel: 0, cost: 0 }],
      items: [merc('m', 100, 0, 10), merc('m2', 100, 0, 200), lava],
      economy: economy({ weapon: 0, supply: 0, lavalux: 1 }, 20, 50)
    }
    const b = solveBundle(input)!
    // 100 × 1.5 = 150 ATK for 10 + 5 WAX, instead of a second mercenary for 200.
    expect(b.cost).toBe(15)
    expect(b.gear.lavalux).toHaveLength(1)
    expect(b.atk).toBe(150)
    expect(b.move).toBe(12)
  })
})
