import type { AnyAction } from '@wharfkit/session'

import { blendActions } from '@/chain/actions/blend'
import { ascendAction, sacrificeAction } from '@/chain/actions/ascend'
import { buySalesActions } from '@/chain/actions/market'
import { FRAGMENT_TEMPLATE } from '@/chain/config'
import type { AscensionConfig } from '@/data/ascension'
import { costKey } from '@/data/ascension'
import type { Blend } from '@/data/blends'
import type { Listing } from '@/data/market'
import { findMinted, walletIdsOf, waitForFragments, walletFragments } from '@/lib/ascendInPlace'
import { planBlend, resultOf, type BlendPlan, type Market } from '@/lib/blendEconomy'

/*
 * The Ascension info page's cheapest routes. Every card that ascends is a line of templates, one per
 * star. Owning a line at star N costs the cheapest of: buying it at N, or buying it at a lower star
 * and ascending it with Fragments. Fragments come from the wallet first, then from whatever is
 * cheapest per Fragment at that point, walking the real listings in price order:
 *
 *  - a Fragment listing (1 Fragment)
 *  - a card listing, sacrificed (its rarity's sure Fragments)
 *  - a card crafted from bought materials, sacrificed (the recipe's result's sure Fragments)
 *
 * Only the sure Fragments of a sacrifice count, never the bonus. Materials you own are not used
 * (they are worth what they sell for); Fragments you own are.
 */

export interface Line {
  /** Templates from no stars up. */
  templates: string[]
  rarity: string
  schema: string
  name: string
}

/** Every ascension line, from the contract's template-to-next-star map. */
export function linesOf(cfg: AscensionConfig, market: Market): Line[] {
  const targets = new Set(cfg.next.values())
  const lines: Line[] = []
  for (const start of cfg.next.keys()) {
    if (targets.has(start)) continue
    const templates = [start]
    while (cfg.next.has(templates[templates.length - 1]) && templates.length < 10) templates.push(cfg.next.get(templates[templates.length - 1])!)
    const t = market.templates.get(start)
    lines.push({ templates, rarity: t?.rarity ?? '', schema: t?.schema ?? '', name: t?.name ?? `#${start}` })
  }
  return lines
}

/** Fragments to go from `from` stars to `to` stars. */
export function fragmentsBetween(cfg: AscensionConfig, rarity: string, from: number, to: number): number {
  let n = 0
  for (let s = from; s < to; s++) n += cfg.costs.get(costKey(rarity, s)) ?? Infinity
  return n
}

/** One unit of Fragment supply, in the order it is taken. */
export type Unit =
  | { kind: 'own'; frags: number; wax: 0 }
  | { kind: 'buy'; frags: 1; wax: number; listing: Listing }
  | { kind: 'sacrifice'; frags: number; wax: number; listing: Listing }
  | { kind: 'craft'; frags: number; wax: number; blend: Blend; plan: BlendPlan; result: string }

export interface Supply {
  units: Unit[]
  /** cost[k]: WAX for the cheapest k Fragments (the shortest prefix of units that reaches k). */
  cost: number[]
  /** prefix[k]: how many units that takes. */
  prefix: number[]
  owned: number
}

/**
 * The cheapest Fragments, one unit after another, up to `target` (or until the market runs out).
 * `exclude`: sale ids not to sacrifice (the cards a route would buy to ascend).
 */
export function fragmentSupply(cfg: AscensionConfig, market: Market, blends: Blend[], target: number, exclude = new Set<string>()): Supply {
  const ownedIds = market.owned.get(FRAGMENT_TEMPLATE) ?? []
  const units: Unit[] = []
  if (ownedIds.length) units.push({ kind: 'own', frags: ownedIds.length, wax: 0 })
  const sure = (rarity: string) => cfg.yields.get(rarity.toLowerCase())?.guaranteed ?? 0

  const fragListings = market.listings.get(FRAGMENT_TEMPLATE) ?? []
  const cardListings = [...market.listings.values()]
    .flat()
    .filter((l) => l.kind && !exclude.has(l.saleId) && sure(l.asset.rarity) > 0)
    .sort((a, b) => a.price / sure(a.asset.rarity) - b.price / sure(b.asset.rarity))
  // Crafting from the market only: owned materials are left alone.
  const bare: Market = { ...market, owned: new Map() }
  const recipes = blends.filter((b) => {
    const r = resultOf(b)
    const t = r ? market.templates.get(r) : null
    return b.active && b.usesLeft > 0 && !!t && t.max - t.issued > 0 && sure(t.rarity) > 0 && t.schema !== 'material'
  })
  const reserved = new Map<string, number>()
  const made = new Map<number, number>()

  let fi = 0
  let ci = 0
  let got = ownedIds.length
  while (got < target) {
    let best: Unit | null = null
    const per = (u: Unit) => u.wax / u.frags
    if (fi < fragListings.length) best = { kind: 'buy', frags: 1, wax: fragListings[fi].price, listing: fragListings[fi] }
    if (ci < cardListings.length) {
      const l = cardListings[ci]
      const u: Unit = { kind: 'sacrifice', frags: sure(l.asset.rarity), wax: l.price, listing: l }
      if (!best || per(u) < per(best)) best = u
    }
    for (const b of recipes) {
      if ((made.get(b.id) ?? 0) >= b.usesLeft) continue
      const plan = planBlend(bare, b, new Map(reserved))
      if (!Number.isFinite(plan.cost)) continue
      const result = resultOf(b)!
      const u: Unit = { kind: 'craft', frags: sure(market.templates.get(result)!.rarity), wax: plan.cost, blend: b, plan, result }
      if (!best || per(u) < per(best)) best = u
    }
    if (!best) break
    if (best.kind === 'buy') fi++
    else if (best.kind === 'sacrifice') ci++
    else {
      planBlend(bare, best.blend, reserved)
      made.set(best.blend.id, (made.get(best.blend.id) ?? 0) + 1)
    }
    units.push(best)
    got += best.frags
  }

  const cost: number[] = [0]
  const prefix: number[] = [0]
  let frags = 0
  let wax = 0
  units.forEach((u, i) => {
    frags += u.frags
    wax += u.wax
    while (cost.length <= frags) {
      cost.push(wax)
      prefix.push(i + 1)
    }
  })
  return { units, cost, prefix, owned: ownedIds.length }
}

export interface Route {
  line: Line
  star: number
  /** The star bought, and its listing. */
  from: number
  listing: Listing
  need: number
  units: Unit[]
  wax: number
  /** Transactions, one after another. */
  txs: number
}

/** The cheapest way to own a line at a star; null when nothing on the market gets there. */
export function cheapestRoute(cfg: AscensionConfig, market: Market, supply: Supply, line: Line, star: number): Route | null {
  let best: Route | null = null
  for (let j = 0; j <= star; j++) {
    const listing = market.listings.get(line.templates[j])?.[0]
    if (!listing) continue
    const need = fragmentsBetween(cfg, line.rarity, j, star)
    if (need >= supply.cost.length) continue
    const units = supply.units.slice(0, supply.prefix[need])
    const wax = listing.price + supply.cost[need]
    if (!best || wax < best.wax) best = { line, star, from: j, listing, need, units, wax, txs: txCount(star - j, units) }
  }
  return best
}

/** Buying and the first ascension share a transaction; crafting and sacrificing come first; each further star is one more. */
function txCount(steps: number, units: Unit[]): number {
  if (!steps) return 1
  const crafts = units.some((u) => u.kind === 'craft')
  const sacrifices = crafts || units.some((u) => u.kind === 'sacrifice')
  return steps + (crafts ? 1 : 0) + (sacrifices ? 1 : 0)
}

/** "uses your 3 Fragments, 12 bought, 4 Red Boar crafted and sacrificed" */
export const routeSources = (route: Route, market: Market) => unitSources(route.units, route.need, market)

/** Where Fragments come from, in words. */
export function unitSources(units: Unit[], need: number, market: Market): string[] {
  const route = { units }
  const out: string[] = []
  const own = route.units.find((u) => u.kind === 'own')
  if (own) out.push(`your ${Math.min(own.frags, need)} Fragment${own.frags === 1 ? '' : 's'}`)
  const bought = route.units.filter((u) => u.kind === 'buy').length
  if (bought) out.push(`${bought} Fragment${bought === 1 ? '' : 's'} bought`)
  const count = (kind: 'sacrifice' | 'craft') => {
    const m = new Map<string, number>()
    for (const u of route.units) {
      if (u.kind !== kind) continue
      const name = kind === 'craft' ? (market.templates.get((u as Extract<Unit, { kind: 'craft' }>).result)?.name ?? 'card') : (u as Extract<Unit, { kind: 'sacrifice' }>).listing.asset.name
      m.set(name, (m.get(name) ?? 0) + 1)
    }
    return [...m].map(([n, c]) => `${c}× ${n}`)
  }
  const sac = count('sacrifice')
  if (sac.length) out.push(`${sac.join(', ')} bought and sacrificed`)
  const craft = count('craft')
  if (craft.length) out.push(`${craft.join(', ')} crafted and sacrificed`)
  return out
}

export interface Part {
  build: (a: string, p: string) => AnyAction[] | AnyAction | Promise<AnyAction[] | AnyAction>
  success: string
  settle?: boolean
}

const sale = (l: Listing) => ({ saleId: l.saleId, assetId: l.assetId, listingPrice: l.listingPrice })

/**
 * Getting Fragments: crafting (materials bought and blends run; the cards are minted a few seconds
 * later), then sacrificing (bought cards in the same transaction, and the crafted ones). Fragment
 * listings are not bought here: they go in the transaction that ascends (`buys`), and `fragments`
 * gives that transaction the Fragments it ascends with, waiting for a sacrifice's reveal first.
 */
export function acquireFragments(
  units: Unit[],
  need: number
): { parts: Part[]; buys: Listing[]; fragments: (owner: string) => Promise<string[]> } {
  const parts: Part[] = []
  const crafts = units.filter((u): u is Extract<Unit, { kind: 'craft' }> => u.kind === 'craft')
  const sacrifices = units.filter((u): u is Extract<Unit, { kind: 'sacrifice' }> => u.kind === 'sacrifice')
  const buys = units.filter((u): u is Extract<Unit, { kind: 'buy' }> => u.kind === 'buy').map((u) => u.listing)
  const craftResults = new Set(crafts.map((c) => c.result))
  let beforeCraft = new Set<string>()
  if (crafts.length)
    parts.push({
      build: async (a, p) => {
        beforeCraft = new Set((await Promise.all([...craftResults].map((t) => walletIdsOf(a, t)))).flatMap((x) => [...x]))
        return [
          ...buySalesActions(a, p, crafts.flatMap((c) => c.plan.buy).map(sale)),
          ...blendActions(a, p, crafts.map((c) => ({ blendId: c.blend.id, assetIds: c.plan.assets })))
        ]
      },
      success: `Crafted ${crafts.length} card${crafts.length === 1 ? '' : 's'} to sacrifice`,
      settle: true
    })
  const burns = sacrifices.length + crafts.length
  if (burns)
    parts.push({
      build: async (a, p) => {
        const crafted = crafts.length ? await findMinted(a, craftResults, beforeCraft, crafts.length) : []
        const bought = sacrifices.map((x) => x.listing)
        return [...buySalesActions(a, p, bought.map(sale)), sacrificeAction(a, p, [...bought.map((l) => l.assetId), ...crafted])]
      },
      success: `Sacrificed ${burns} card${burns === 1 ? '' : 's'} for Fragments`,
      settle: true
    })
  const inWallet = Math.max(0, need - buys.length)
  return {
    parts,
    buys,
    fragments: async (owner) => {
      const wallet = burns ? await waitForFragments(owner, inWallet) : await walletFragments(owner)
      return [...buys.map((l) => l.assetId), ...wallet]
    }
  }
}

/** Fragment listings bought in the transaction that ascends. */
export const buyFragmentActions = (a: string, p: string, buys: Listing[]): AnyAction[] => (buys.length ? buySalesActions(a, p, buys.map(sale)) : [])

/** The signed sequence for a route: craft, sacrifice, buy and ascend, then one more ascension per star. */
export function routeTransactions(route: Route, market: Market, cfg: AscensionConfig): Part[] {
  const stepCost = (s: number) => cfg.costs.get(costKey(route.line.rarity, s)) ?? 0
  const { line, from, star, listing } = route
  const nameAt = (s: number) => market.templates.get(line.templates[s])?.name ?? line.name
  if (from === star) return [{ build: (a, p) => buySalesActions(a, p, [sale(listing)]), success: `Bought ${nameAt(star)} ★${star}` }]

  const got = acquireFragments(route.units, route.need)
  const parts = [...got.parts]
  // The card bought, the Fragment listings bought, and the first star, together.
  let before = new Set<string>()
  parts.push({
    build: async (a, p) => {
      const ids = (await got.fragments(a)).slice(0, stepCost(from))
      before = await walletIdsOf(a, line.templates[from + 1])
      return [...buySalesActions(a, p, [listing, ...got.buys].map(sale)), ascendAction(a, p, listing.assetId, ids)]
    },
    success: `${nameAt(from)} bought and ascended to ★${from + 1}`,
    settle: star > from + 1
  })
  // Every further star: the card the last step minted, and Fragments from the wallet.
  for (let s = from + 1; s < star; s++) {
    const at = s
    parts.push({
      build: async (a, p) => {
        const card = (await findMinted(a, new Set([line.templates[at]]), before, 1))[0]
        before = await walletIdsOf(a, line.templates[at + 1])
        const ids = (await walletFragments(a)).slice(0, stepCost(at))
        return ascendAction(a, p, card, ids)
      },
      success: `${nameAt(at)} ascended to ★${at + 1}`,
      settle: at + 1 < star
    })
  }
  return parts
}
