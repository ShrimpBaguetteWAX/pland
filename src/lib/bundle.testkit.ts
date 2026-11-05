import { evaluate, type Candidate, type Economy, type SlotKind, type SolveInput } from './bundle'

/** Shared by the solver tests: a seeded generator, a small Forge, and the brute-force optimum. */

/** A tiny seeded generator, so a failing case can be reproduced. */
export function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

const offer = (wax: number, level: number, i: number) => ({
  itemId: i,
  price: '1.00000000 DEF',
  priceContract: 'defensetoken',
  def: 1,
  wax,
  level
})

/** A Forge with `free` slots per kind, two more for sale (the second needs level 1), and level 1 costing `levelWax`. */
export function economy(free: Record<SlotKind, number>, slotWax: number, levelWax: number): Economy {
  const offers = (k: number) => [offer(slotWax, 0, k), offer(slotWax * 2, 1, k + 1)]
  return {
    forgeLevel: 0,
    levelWax: [0, levelWax, Infinity, Infinity, Infinity, Infinity],
    levelTlm: [0, 1000, 0, 0, 0, 0],
    slots: {
      weapon: { free: free.weapon, offers: offers(10) },
      supply: { free: free.supply, offers: offers(20) },
      lavalux: { free: free.lavalux, offers: offers(30) }
    }
  }
}

export const merc = (key: string, atk: number, def: number, cost: number, move = 10): Candidate => ({
  key,
  kind: 'mercenary',
  group: key,
  atk,
  def,
  move,
  moveReduction: 0,
  minLevel: 0,
  cost
})

/**
 * Every subset of items with the cheapest fitting warlord, paying for the slots and the Forge
 * level it needs: the true optimum (flat-stat gear only).
 */
export function bruteForce(input: SolveInput): number {
  let best = Infinity
  const n = input.items.length
  const eco = input.economy
  for (let mask = 1; mask < 1 << n; mask++) {
    const chosen = input.items.filter((_, i) => mask & (1 << i))
    const count = (k: string) => chosen.filter((c) => c.kind === k).length
    const mercs = count('mercenary')
    if (!mercs) continue
    if (['weapon', 'supply', 'creature', 'lavalux'].some((k) => count(k) > mercs)) continue
    if (chosen.reduce((s, c) => s + c.atk, 0) < input.atk || chosen.reduce((s, c) => s + c.def, 0) < input.def) continue
    const w = input.warlords.filter((o) => o.slots >= mercs).sort((a, b) => a.cost - b.cost)[0]
    if (!w) continue
    let slotWax = 0
    let level = eco.forgeLevel
    let ok = true
    for (const k of ['weapon', 'supply', 'lavalux'] as SlotKind[]) {
      const extra = Math.max(0, count(k) - eco.slots[k].free)
      if (extra > eco.slots[k].offers.length) ok = false
      for (const o of eco.slots[k].offers.slice(0, extra)) {
        slotWax += o.wax
        level = Math.max(level, o.level)
      }
    }
    if (!ok) continue
    if (input.maxMove) {
      const gear = (k: string) => chosen.filter((c) => c.kind === k)
      const ev = evaluate({
        warlord: w,
        mercs: gear('mercenary'),
        gear: { weapon: gear('weapon'), supply: gear('supply'), creature: gear('creature'), lavalux: gear('lavalux') }
      })
      if (ev.move > input.maxMove) continue
    }
    best = Math.min(best, w.cost + chosen.reduce((s, c) => s + c.cost, 0) + slotWax + eco.levelWax[level])
  }
  return best
}
