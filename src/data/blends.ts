import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { atomic, type TemplatePrice } from '@/chain/atomic'
import { getRows } from '@/chain/rpc'

/*
 * Planetary Defense blends run on NeftyBlocks' blend contract (blend.nefty): the blend table,
 * scoped to the contract, holds every collection's recipes keyed by blend id. The collection's
 * recipes start at id 41032 (the Quantum Chest openings); reading from there to the end of the
 * table is a handful of pages, cached for a while since recipes rarely change.
 */

export const BLEND_CONTRACT = 'blend.nefty'
const COLLECTION = 'planetdefnft'
const FIRST_BLEND_ID = 41032

export const QUANTUM_CHEST = '874216'
export const QUANTUM_KEY = '874218'

export type Ingredient =
  | { type: 'template'; templateId: string; amount: number }
  | { type: 'attribute'; schema: string; attributes: { name: string; values: string[] }[]; amount: number }
  | { type: 'other'; amount: number; label: string }

export interface BlendOutcome {
  templateId: string | null
  /** 0…1 */
  chance: number
}

export interface Blend {
  id: number
  category: string
  ingredients: Ingredient[]
  outcomes: BlendOutcome[]
  /** Uses left under the recipe's own cap (Infinity when uncapped). */
  usesLeft: number
  active: boolean
}

type Variant<T> = [string, T]

interface BlendRow {
  blend_id: number
  collection_name: string
  start_time: number
  end_time: number
  ingredients: Variant<Record<string, unknown>>[]
  rolls: { outcomes: { odds: number; results: Variant<{ template_id?: number }>[] }[]; total_odds: number }[]
  max: number
  use_count: number
  is_hidden?: number | boolean
  category?: string
}

function parse(row: BlendRow, now: number): Blend {
  const ingredients: Ingredient[] = row.ingredients.map(([type, d]) => {
    const amount = Number(d.amount ?? 1)
    if (type === 'TEMPLATE_INGREDIENT') return { type: 'template', templateId: String(d.template_id), amount }
    if (type === 'ATTRIBUTE_INGREDIENT') {
      const attrs = (d.attributes as { attribute_name: string; allowed_values: string[] }[]) ?? []
      return {
        type: 'attribute',
        schema: String(d.schema_name ?? ''),
        attributes: attrs.map((a) => ({ name: a.attribute_name, values: a.allowed_values })),
        amount
      }
    }
    return { type: 'other', amount, label: type.replace(/_INGREDIENT$/, '').toLowerCase() }
  })
  // Every PD blend has one roll; its outcomes are the possible results with their odds.
  const roll = row.rolls[0]
  const outcomes: BlendOutcome[] = (roll?.outcomes ?? []).map((o) => {
    const nft = o.results.find(([t]) => t === 'ON_DEMAND_NFT_RESULT')
    return {
      templateId: nft?.[1].template_id ? String(nft[1].template_id) : null,
      chance: roll.total_odds ? o.odds / roll.total_odds : 0
    }
  })
  const max = Number(row.max || 0)
  const usesLeft = max > 0 ? Math.max(0, max - Number(row.use_count || 0)) : Infinity
  const started = !row.start_time || row.start_time * 1000 <= now
  const notEnded = !row.end_time || row.end_time * 1000 > now
  return {
    id: Number(row.blend_id),
    category: row.category ?? '',
    ingredients,
    outcomes,
    usesLeft,
    active: started && notEnded && usesLeft > 0 && !row.is_hidden
  }
}

export function useBlends(): UseQueryResult<Blend[]> {
  return useQuery({
    queryKey: ['blends'],
    queryFn: async () => {
      const rows = await getRows<BlendRow>({
        code: BLEND_CONTRACT,
        scope: BLEND_CONTRACT,
        table: 'blends',
        lower_bound: FIRST_BLEND_ID
      })
      const now = Date.now()
      return rows.filter((r) => r.collection_name === COLLECTION).map((r) => parse(r, now))
    },
    staleTime: 15 * 60_000
  })
}

/** A collection template: what it is, and how many more can be minted. */
export interface CollectionTemplate {
  templateId: string
  schema: string
  name: string
  rarity: string
  img: string
  issued: number
  /** Infinity when uncapped. */
  max: number
}

export function useCollectionTemplates(): UseQueryResult<Map<string, CollectionTemplate>> {
  return useQuery({
    queryKey: ['collection-templates'],
    queryFn: async () => {
      const list = await atomic.getTemplates(COLLECTION)
      return new Map(
        list.map((t) => {
          const d = t.immutable_data
          const max = Number(t.max_supply || 0)
          return [
            String(t.template_id),
            {
              templateId: String(t.template_id),
              schema: t.schema.schema_name,
              name: String(d.name ?? `#${t.template_id}`),
              rarity: String(d.rarity ?? ''),
              img: String(d.img ?? ''),
              issued: Number(t.issued_supply || 0),
              max: max > 0 ? max : Infinity
            }
          ]
        })
      )
    },
    staleTime: 5 * 60_000
  })
}

/** Blend inputs in the wallet (materials and loot: chests, keys, coins), by template. */
export function useOwnedBlendInputs(account: string | null): UseQueryResult<Map<string, string[]>> {
  return useQuery({
    queryKey: ['owned-blend-inputs', account],
    enabled: !!account,
    staleTime: 60_000,
    queryFn: async () => {
      const assets = await atomic.getOwnedAssets(account!, COLLECTION)
      const out = new Map<string, string[]>()
      for (const a of assets) {
        const schema = a.schema.schema_name
        if ((schema !== 'material' && schema !== 'loot') || !a.template) continue
        const t = a.template.template_id
        out.set(t, [...(out.get(t) ?? []), a.asset_id])
      }
      return out
    }
  })
}

/** What each collection template has recently sold for, in WAX (AtomicMarket statistics). */
export function useTemplatePrices(): UseQueryResult<TemplatePrice[]> {
  return useQuery({
    queryKey: ['template-prices'],
    queryFn: () => atomic.getTemplatePrices(COLLECTION),
    staleTime: 10 * 60_000
  })
}
