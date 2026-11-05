import type { ForgeLevelRow, ForgeProgressRow, ShopItemRow } from '@/data/types'

import type { Economy, SlotKind, SlotOffer } from './bundle'
import { parseAsset } from './format'
import { costToReceive, sideOf, type Pool } from './pool'

/** Which Forge shop powerup counts the slots of each gear kind. */
export const SLOT_POWERUP: Record<SlotKind, string> = { weapon: 'eqpslot', supply: 'supslot', lavalux: 'lavaslot' }

/** Offers looked at per kind: far more slots than any one division can use. */
const MAX_OFFERS = 80

interface EconomyInput {
  forgeLevel: number
  progress: ForgeProgressRow | null
  levels: ForgeLevelRow[]
  shopItems: ShopItemRow[]
  /** Slots bought so far, per powerup id. */
  powerups: Map<string, number>
  /** Gear of each kind already equipped across the army (those slots are taken). */
  used: Record<SlotKind, number>
  pools: { def: Pool; tlm: Pool }
}

/** WAX that buying `amount` of `symbol` costs on its Alcor pool (fee and price impact included). */
export const waxFor = (pool: Pool, symbol: string, amount: number) => costToReceive(pool, sideOf(pool, symbol), amount)

/**
 * The player's Forge as the solver sees it, everything priced in WAX: what each higher level costs
 * (TLM, minus what is already paid towards the next one), the free slots of every kind, and the
 * next slots for sale in purchase order.
 */
export function buildEconomy(e: EconomyInput): Economy {
  const levelTlm = [0, 0, 0, 0, 0, 0].map(() => Infinity)
  levelTlm[e.forgeLevel] = 0
  let tlm = 0
  for (let L = e.forgeLevel + 1; L <= 5; L++) {
    const row = e.levels.find((l) => Number(l.level) === L)
    if (!row) break
    let cost = parseAsset(row.tlm_cost).amount
    if (L === e.forgeLevel + 1) cost = Math.max(0, cost - parseAsset(e.progress?.paid_tlm).amount)
    tlm += cost
    levelTlm[L] = tlm
  }
  const levelWax = levelTlm.map((t, L) =>
    L < e.forgeLevel ? Infinity : Number.isFinite(t) ? waxFor(e.pools.tlm, 'TLM', t) : Infinity
  )

  const slots = {} as Economy['slots']
  for (const kind of Object.keys(SLOT_POWERUP) as SlotKind[]) {
    const key = SLOT_POWERUP[kind]
    const owned = e.powerups.get(key) ?? 0
    const items = e.shopItems
      .filter((i) => String(i.reward_powerup) === key)
      .sort((a, b) => Number(a.min_forge_level) - Number(b.min_forge_level) || Number(a.id) - Number(b.id))
      .slice(owned, owned + MAX_OFFERS)
    // Marginal WAX per slot: buying the DEF for all of them at once moves the pool, so later ones cost a little more.
    let def = 0
    let wax = 0
    const offers: SlotOffer[] = items.map((i) => {
      const p = parseAsset(i.price)
      def += p.symbol === 'DEF' ? p.amount : 0
      const total = p.symbol === 'DEF' ? waxFor(e.pools.def, 'DEF', def) : wax + waxFor(e.pools.tlm, 'TLM', p.amount)
      const offer: SlotOffer = {
        itemId: Number(i.id),
        price: i.price,
        priceContract: i.price_contract || 'defensetoken',
        def: p.symbol === 'DEF' ? p.amount : 0,
        wax: total - wax,
        level: Number(i.min_forge_level)
      }
      wax = total
      return offer
    })
    slots[kind] = { free: Math.max(0, owned - e.used[kind]), offers }
  }
  return { forgeLevel: e.forgeLevel, levelWax, levelTlm, slots }
}
