import type { Blend, CollectionTemplate, Ingredient } from '@/data/blends'
import { QUANTUM_CHEST, QUANTUM_KEY } from '@/data/blends'
import type { Listing } from '@/data/market'

/*
 * What blending is worth, in WAX: every material's floor price, what it should cost given the price
 * of Quantum Chests and Keys and the opening odds, what it is worth when blended, and for every
 * recipe the cost of its ingredients against the price of its result.
 */

/**
 * What a seller keeps of a sale on AtomicMarket: the collection takes 5%, the listing and the buying
 * marketplace 1% each. Every value that assumes selling something is scaled by this.
 */
export const SALE_KEEP = 0.93

export interface Market {
  /** Listings per template, cheapest first. */
  listings: Map<string, Listing[]>
  /** Asset ids per template in the wallet. */
  owned: Map<string, string[]>
  templates: Map<string, CollectionTemplate>
  /** Median of recent sales per template (only templates with enough sales to mean something). */
  recent: Map<string, number>
}

/** Fewer sales than this and a median is one or two lucky trades, not a price. */
const MIN_SALES = 5

export function marketFrom(
  listings: Listing[],
  owned: Map<string, string[]>,
  templates: Map<string, CollectionTemplate>,
  account: string | null,
  prices: { templateId: string; median: number; sales: number }[] = []
): Market {
  const recent = new Map(prices.filter((p) => p.sales >= MIN_SALES && p.median > 0).map((p) => [p.templateId, p.median]))
  const byTemplate = new Map<string, Listing[]>()
  for (const l of listings) {
    // Your own listings cannot be bought by you.
    if (l.seller === account) continue
    byTemplate.set(l.templateId, [...(byTemplate.get(l.templateId) ?? []), l])
  }
  for (const list of byTemplate.values()) list.sort((a, b) => a.price - b.price)
  return { listings: byTemplate, owned, templates, recent }
}

export const floorOf = (m: Market, templateId: string) => m.listings.get(templateId)?.[0]?.price ?? null

/**
 * What a template is worth on the market: the lower of its floor (you must undercut it to sell) and
 * its recent sale median (a lone listing far above what it sells for is not a price). Either alone
 * when only one exists: most Epic and rarer materials sell often but are almost never listed.
 */
export function valueOf(m: Market, templateId: string): number | null {
  const floor = floorOf(m, templateId)
  const recent = m.recent.get(templateId) ?? null
  if (floor !== null && recent !== null) return Math.min(floor, recent)
  return floor ?? recent
}

const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

// ---- Openings: Quantum Chest, and Chest + Key -------------------------------------------------------

export interface Opening {
  blend: Blend
  withKey: boolean
  /** WAX for one opening at today's floors (chest, plus key), or null if either is not listed. */
  cost: number | null
  outcomes: { templateId: string; chance: number }[]
}

export function openingsOf(blends: Blend[]): { chest: Opening | null; chestKey: Opening | null } {
  const find = (withKey: boolean) => {
    const b = blends.find((x) => {
      const ids = x.ingredients.map((i) => (i.type === 'template' ? i.templateId : '?')).sort()
      return withKey ? ids.join() === [QUANTUM_CHEST, QUANTUM_KEY].sort().join() : ids.join() === QUANTUM_CHEST
    })
    return b
      ? {
          blend: b,
          withKey,
          cost: null,
          outcomes: b.outcomes.filter((o) => o.templateId).map((o) => ({ templateId: o.templateId!, chance: o.chance }))
        }
      : null
  }
  return { chest: find(false), chestKey: find(true) }
}

export interface MaterialValue {
  templateId: string
  name: string
  rarity: string
  img: string
  floor: number | null
  listed: number
  owned: number
  /** Where it drops, and how likely. */
  source: 'chest' | 'chestKey' | null
  chance: number
  /** Opening cost / chance: WAX to pull this one on average. */
  pullCost: number | null
  /** Recent sale median, when it has sold often enough. */
  recent: number | null
  /** Market value: min(floor, recent median), or whichever exists. */
  value: number | null
  /** Its fair share of an opening, split by the market's price ratio between rarity tiers. */
  fair: number | null
  /** One unit's share of the best recipe's result value (split by the ingredients' market values). */
  blendValue: number | null
  blendVia: Blend | null
  /** max(value after sale fees, blend value): what one unit is really worth to you. */
  worth: number | null
}

/** Cost of `amount` units of a template: owned ones first (free), then the cheapest listings. */
export function unitsCost(m: Market, templateId: string, amount: number, reserved = new Map<string, number>()) {
  const usedOwned = reserved.get(`own:${templateId}`) ?? 0
  const usedListed = reserved.get(`buy:${templateId}`) ?? 0
  const owned = Math.max(0, (m.owned.get(templateId)?.length ?? 0) - usedOwned)
  const fromOwned = Math.min(owned, amount)
  const rest = amount - fromOwned
  const list = (m.listings.get(templateId) ?? []).slice(usedListed, usedListed + rest)
  if (list.length < rest) return { cost: Infinity, fromOwned, buy: list }
  return { cost: list.reduce((n, l) => n + l.price, 0), fromOwned, buy: list }
}

/** Templates an attribute ingredient accepts (e.g. "any Common material"). */
export function matching(m: Market, ing: Extract<Ingredient, { type: 'attribute' }>): string[] {
  return [...m.templates.values()]
    .filter(
      (t) =>
        (!ing.schema || t.schema === ing.schema) &&
        ing.attributes.every((a) => a.name !== 'rarity' || a.values.map((v) => v.toLowerCase()).includes(t.rarity.toLowerCase()))
    )
    .map((t) => t.templateId)
}

/**
 * The cheapest way to cover one ingredient: owned units first, then listings, across every template
 * an attribute ingredient accepts. Records what it takes in `reserved` so later ingredients (or
 * later runs of the same recipe) do not count the same NFTs twice.
 */
export function coverIngredient(m: Market, ing: Ingredient, reserved: Map<string, number>) {
  if (ing.type === 'other') return { cost: Infinity, use: [] as string[], buy: [] as Listing[] }
  const candidates = ing.type === 'template' ? [ing.templateId] : matching(m, ing)
  const use: string[] = []
  const buy: Listing[] = []
  let cost = 0
  for (let n = 0; n < ing.amount; n++) {
    // Take the cheapest single unit available across the accepted templates.
    let best: { t: string; price: number; owned: boolean } | null = null
    for (const t of candidates) {
      const ownedLeft = (m.owned.get(t)?.length ?? 0) - (reserved.get(`own:${t}`) ?? 0)
      if (ownedLeft > 0) {
        best = { t, price: 0, owned: true }
        break
      }
      const next = m.listings.get(t)?.[reserved.get(`buy:${t}`) ?? 0]
      if (next && (!best || next.price < best.price)) best = { t, price: next.price, owned: false }
    }
    if (!best) return { cost: Infinity, use, buy }
    if (best.owned) {
      const i = reserved.get(`own:${best.t}`) ?? 0
      use.push(m.owned.get(best.t)![i])
      reserved.set(`own:${best.t}`, i + 1)
    } else {
      const i = reserved.get(`buy:${best.t}`) ?? 0
      buy.push(m.listings.get(best.t)![i])
      reserved.set(`buy:${best.t}`, i + 1)
      cost += best.price
    }
  }
  return { cost, use, buy }
}

export interface BlendPlan {
  cost: number
  /** Owned NFTs burned, and listings to buy (their NFTs are burned too, in the same transaction). */
  use: string[]
  buy: Listing[]
  /** Every NFT the run burns, in ingredient order (owned and bought). */
  assets: string[]
  /** Per ingredient: WAX spent and how many units came from the wallet. */
  lines: { ingredient: Ingredient; cost: number; owned: number }[]
}

/** Plans one run of a recipe from what you own and the market, sharing `reserved` across runs. */
export function planBlend(m: Market, blend: Blend, reserved = new Map<string, number>()): BlendPlan {
  const lines: BlendPlan['lines'] = []
  const use: string[] = []
  const buy: Listing[] = []
  const assets: string[] = []
  let cost = 0
  for (const ing of blend.ingredients) {
    const c = coverIngredient(m, ing, reserved)
    lines.push({ ingredient: ing, cost: c.cost, owned: c.use.length })
    use.push(...c.use)
    buy.push(...c.buy)
    assets.push(...c.use, ...c.buy.map((l) => l.assetId))
    cost += c.cost
  }
  return { cost, use, buy, assets, lines }
}

/** A recipe's single result, when it has exactly one (crafting). */
export const resultOf = (b: Blend) => (b.outcomes.length === 1 && b.outcomes[0].templateId ? b.outcomes[0].templateId : null)

/** How many more a recipe can make: its own use cap and the result template's mint cap. */
export function mintable(m: Market, b: Blend): number {
  const r = resultOf(b)
  const t = r ? m.templates.get(r) : null
  const templateLeft = t ? Math.max(0, t.max - t.issued) : Infinity
  return Math.min(b.usesLeft, templateLeft)
}

// ---- Material values -------------------------------------------------------------------------------

/** Market value of one ingredient's whole amount: the template's value, or the cheapest accepted template's. */
export function ingredientValue(m: Market, ing: Ingredient): number | null {
  if (ing.type === 'other') return null
  const ids = ing.type === 'template' ? [ing.templateId] : matching(m, ing)
  const values = ids.map((t) => valueOf(m, t)).filter((v): v is number => v !== null)
  return values.length ? Math.min(...values) * ing.amount : null
}

export function materialValues(
  m: Market,
  blends: Blend[]
): { materials: MaterialValue[]; openings: { chest: Opening | null; chestKey: Opening | null } } {
  const openings = openingsOf(blends)
  const chestPrice = floorOf(m, QUANTUM_CHEST)
  const keyPrice = floorOf(m, QUANTUM_KEY)
  if (openings.chest) openings.chest.cost = chestPrice
  if (openings.chestKey) openings.chestKey.cost = chestPrice !== null && keyPrice !== null ? chestPrice + keyPrice : null

  // Fair value: an opening's cost split across its outcomes in proportion to the market value of
  // their rarity tier (median value within the tier), so buying at fair values breaks even.
  const fair = new Map<string, number>()
  const where = new Map<string, { source: 'chest' | 'chestKey'; chance: number }>()
  for (const [source, o] of [
    ['chest', openings.chest],
    ['chestKey', openings.chestKey]
  ] as const) {
    if (!o) continue
    const tierOf = (t: string) => m.templates.get(t)?.rarity ?? '?'
    const tiers = new Map<string, number | null>()
    for (const out of o.outcomes) {
      where.set(out.templateId, { source, chance: out.chance })
      const t = tierOf(out.templateId)
      if (!tiers.has(t))
        tiers.set(
          t,
          median(
            o.outcomes
              .filter((x) => tierOf(x.templateId) === t)
              .map((x) => valueOf(m, x.templateId))
              .filter((p): p is number => p !== null)
          )
        )
    }
    const allPriced = [...tiers.values()].every((v) => v !== null)
    // Without a price for every tier, weigh by rarity alone: rarer is dearer in proportion to its odds.
    const weight = (out: { templateId: string; chance: number }) =>
      allPriced ? tiers.get(tierOf(out.templateId))! : 1 / out.chance
    const denom = o.outcomes.reduce((n, out) => n + out.chance * weight(out), 0)
    if (o.cost !== null && denom > 0) for (const out of o.outcomes) fair.set(out.templateId, (o.cost * weight(out)) / denom)
  }

  // Blend value: a recipe's result, sold after fees, split across its ingredients in proportion to
  // their market values (fair value when a material has no market at all). The shares add up to
  // the result exactly, so no material is credited with surplus that another one also claims.
  const blendValue = new Map<string, { value: number; via: Blend }>()
  for (const b of blends) {
    const r = resultOf(b)
    if (!b.active || !r || mintable(m, b) <= 0) continue
    const resultValue = valueOf(m, r)
    if (resultValue === null) continue
    const net = resultValue * SALE_KEEP
    // Per unit for template ingredients; for the whole amount for attribute ones.
    const weights = b.ingredients.map((ing) =>
      ing.type === 'template' ? (valueOf(m, ing.templateId) ?? fair.get(ing.templateId) ?? null) : ingredientValue(m, ing)
    )
    if (weights.some((w) => w === null || w <= 0)) continue
    const total = b.ingredients.reduce((n, ing, i) => n + weights[i]! * (ing.type === 'template' ? ing.amount : 1), 0)
    b.ingredients.forEach((ing, i) => {
      if (ing.type !== 'template') return
      const value = (net * weights[i]!) / total
      if (value > (blendValue.get(ing.templateId)?.value ?? 0)) blendValue.set(ing.templateId, { value, via: b })
    })
  }

  const materials: MaterialValue[] = [...m.templates.values()]
    .filter((t) => t.schema === 'material')
    .map((t) => {
      const w = where.get(t.templateId)
      const src = w ? (w.source === 'chest' ? openings.chest : openings.chestKey) : null
      const value = valueOf(m, t.templateId)
      const bv = blendValue.get(t.templateId) ?? null
      const worthParts = [value === null ? null : value * SALE_KEEP, bv?.value ?? null].filter((x): x is number => x !== null)
      return {
        templateId: t.templateId,
        name: t.name,
        rarity: t.rarity,
        img: t.img,
        floor: floorOf(m, t.templateId),
        recent: m.recent.get(t.templateId) ?? null,
        value,
        listed: m.listings.get(t.templateId)?.length ?? 0,
        owned: m.owned.get(t.templateId)?.length ?? 0,
        source: w?.source ?? null,
        chance: w?.chance ?? 0,
        pullCost: src?.cost != null && w ? src.cost / w.chance : null,
        fair: fair.get(t.templateId) ?? null,
        blendValue: bv?.value ?? null,
        blendVia: bv?.via ?? null,
        worth: worthParts.length ? Math.max(...worthParts) : null
      }
    })
  return { materials, openings }
}

/**
 * What an opening returns, after sale fees, valued two ways: selling every material at its market
 * value, or using each the best way (sell or blend). Also the share of outcomes that have no price.
 */
export function openingValue(o: Opening, materials: Map<string, MaterialValue>) {
  // Outcomes without any price count as nothing (never as their fair value, which is derived from
  // the opening price itself and would make any opening look break-even).
  let sell = 0
  let best = 0
  let unpricedSell = 0
  let unpricedBest = 0
  for (const out of o.outcomes) {
    const mv = materials.get(out.templateId)
    if (mv?.value == null) unpricedSell += out.chance
    else sell += out.chance * mv.value * SALE_KEEP
    if (mv?.worth == null) unpricedBest += out.chance
    else best += out.chance * mv.worth
  }
  return { sell, best, unpricedSell, unpricedBest }
}
