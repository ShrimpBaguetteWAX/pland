import { QUANTUM_CHEST, QUANTUM_KEY } from '@/data/blends'

import { floorOf, SALE_KEEP, valueOf, type Market, type Opening } from './blendEconomy'

/*
 * What opening Quantum Chests first would do to a bundle's price. A bundle that blends buys the
 * materials its recipes still need; every chest pulls one material at random, so some of those
 * buys would be covered. The expected saving is exact: per material, the number pulled is a sum
 * of binomials (one per kind of opening), and a pull is worth the dearest listing it replaces.
 */

export interface OpeningPlan {
  opening: Opening
  count: number
}

export interface ChestForecast {
  /** Openings in all. */
  openings: number
  /** WAX for the chests (and keys) at today's floors; null when one of them is not listed. */
  cost: number | null
  /** Materials the bundle would otherwise buy. */
  needed: number
  /** Of those, how many the openings cover on average. */
  covered: number
  /** Expected decrease of the bundle's price. */
  saving: number
  /** Expected market value, after sale fees, of the materials pulled that the bundle does not need. */
  surplus: number
  /** Share of the outcomes without a market price, which the surplus leaves out. */
  unpriced: number
}

/** Probability of exactly k successes in n draws at p, for k = 0..n. */
export function binomialPmf(n: number, p: number): number[] {
  const pmf = new Array<number>(n + 1).fill(0)
  if (n === 0) return [1]
  if (p <= 0) {
    pmf[0] = 1
    return pmf
  }
  if (p >= 1) {
    pmf[n] = 1
    return pmf
  }
  // Iteratively: P(k+1) = P(k) × (n−k)/(k+1) × p/(1−p), from P(0) = (1−p)^n.
  let v = (1 - p) ** n
  const ratio = p / (1 - p)
  for (let k = 0; k <= n; k++) {
    pmf[k] = v
    v *= ((n - k) / (k + 1)) * ratio
  }
  return pmf
}

/** Distribution of the sum of two independent counts. */
export function convolve(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0)
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue
    for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j]
  }
  return out
}

/** Chance of each outcome per opening, normalised in case the recipe's odds do not sum to one. */
export function oddsOf(o: Opening): Map<string, number> {
  const total = o.outcomes.reduce((n, x) => n + x.chance, 0)
  const odds = new Map<string, number>()
  for (const x of o.outcomes) odds.set(x.templateId, (odds.get(x.templateId) ?? 0) + (total > 0 ? x.chance / total : 0))
  return odds
}

/**
 * The expected effect of `plans` (so many openings of each kind) on a bundle that buys `buys`
 * (one entry per material listing bought). Materials the bundle does not need are valued at what
 * they would sell for.
 */
export function forecastOpenings(plans: OpeningPlan[], buys: { templateId: string; price: number }[], m: Market): ChestForecast {
  const active = plans.filter((p) => p.count > 0)
  const openings = active.reduce((n, p) => n + p.count, 0)
  const chestFloor = floorOf(m, QUANTUM_CHEST)
  const keyFloor = floorOf(m, QUANTUM_KEY)
  let cost: number | null = 0
  for (const p of active) {
    const each =
      chestFloor === null || (p.opening.withKey && keyFloor === null) ? null : chestFloor + (p.opening.withKey ? keyFloor! : 0)
    cost = cost === null || each === null ? null : cost + each * p.count
  }

  // The dearest listing of a material is the one a pull replaces first.
  const needs = new Map<string, number[]>()
  for (const b of buys)
    needs.set(
      b.templateId,
      [...(needs.get(b.templateId) ?? []), b.price].sort((x, y) => y - x)
    )

  const odds = active.map((p) => ({ count: p.count, odds: oddsOf(p.opening) }))
  const templates = new Set<string>([...needs.keys(), ...odds.flatMap((o) => [...o.odds.keys()])])

  let covered = 0
  let saving = 0
  let surplus = 0
  let unpriced = 0
  for (const t of templates) {
    let pmf = [1]
    let mean = 0
    for (const o of odds) {
      const q = o.odds.get(t) ?? 0
      if (q <= 0) continue
      pmf = convolve(pmf, binomialPmf(o.count, q))
      mean += o.count * q
    }
    const prices = needs.get(t) ?? []
    const prefix = [0]
    for (const price of prices) prefix.push(prefix[prefix.length - 1] + price)
    let hits = 0
    let worth = 0
    for (let k = 0; k < pmf.length; k++) {
      const used = Math.min(k, prices.length)
      hits += pmf[k] * used
      worth += pmf[k] * prefix[used]
    }
    covered += hits
    saving += worth
    const extra = mean - hits
    if (extra > 1e-9) {
      const value = valueOf(m, t)
      if (value === null) unpriced += extra
      else surplus += extra * value * SALE_KEEP
    }
  }
  const pulled = odds.reduce((n, o) => n + o.count, 0)
  return {
    openings,
    cost,
    needed: buys.length,
    covered,
    saving,
    surplus,
    unpriced: pulled > 0 ? unpriced / pulled : 0
  }
}
