import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { atomic, type AtomicSale } from '@/chain/atomic'
import { ALCOR_DEF_WAX_POOL_ID, ALCOR_TLM_DEF_POOL_ID, ALCOR_TLM_WAX_POOL_ID, CONTRACTS } from '@/chain/config'
import { getRow } from '@/chain/rpc'
import { poolFromRow, type Pool } from '@/lib/pool'
import { kindOfCategory, type Kind } from '@/lib/stats'

import { cachedOf, makeAssetRef, type AssetRef } from './assets'
import { useAssetStats, useTemplates } from './game'

/** Playable schemas (they go into divisions) and blend inputs (materials, and loot: chests, keys, coins). */
const PD_SCHEMAS = ['warlord', 'mercenary', 'equipment', 'supplies', 'creature', 'services', 'material', 'loot']

export interface Listing {
  saleId: string
  assetId: string
  /** Raw price in WAX's smallest unit (8 decimals), exactly as listed: used to assert the sale. */
  listingPrice: string
  /** Price in WAX. */
  price: number
  seller: string
  asset: AssetRef
  templateId: string
  schema: string
  /** What the NFT is in a division; null for materials and loot. */
  kind: Kind | null
}

/**
 * Every open AtomicMarket sale of a game NFT: the Planetary Defense collection's playable schemas
 * and blend inputs, plus the few Alien Worlds templates the game accepts. Only single-NFT sales
 * priced in WAX are kept (USD-priced sales settle through a price oracle; bundles cannot be split).
 */
export function useListings(): UseQueryResult<Listing[]> {
  const stats = useAssetStats()
  const templates = useTemplates()
  return useQuery({
    queryKey: ['market-listings'],
    enabled: stats.isSuccess && templates.isSuccess,
    staleTime: 60_000,
    refetchInterval: 120_000,
    queryFn: async () => {
      const statsMap = stats.data!
      // Game templates that do not belong to the PD collection: the Alien Worlds ones.
      const awTemplates = [...statsMap.keys()].filter((t) => !templates.data![t] && Number(t) < 874000)
      const batches = await Promise.all([
        ...PD_SCHEMAS.map((schema) => atomic.getSales({ collection_name: 'planetdefnft', schema_name: schema })),
        awTemplates.length
          ? atomic.getSales({ collection_name: 'alien.worlds', template_id: awTemplates.join(',') })
          : Promise.resolve([])
      ])
      const out: Listing[] = []
      const seen = new Set<string>()
      for (const sale of batches.flat() as AtomicSale[]) {
        if (seen.has(sale.sale_id)) continue
        seen.add(sale.sale_id)
        if (sale.listing_symbol !== 'WAX' || sale.price?.token_symbol !== 'WAX' || sale.assets.length !== 1) continue
        const a = sale.assets[0]
        const c = cachedOf(a)
        if (!c) continue
        const st = statsMap.get(c.t)
        const kind = kindOfCategory(st?.category)
        const blendInput = c.s === 'material' || c.s === 'loot'
        // Playable NFTs need game stats; materials and loot have none.
        if (!blendInput && (!st || !kind)) continue
        out.push({
          saleId: String(sale.sale_id),
          assetId: String(a.asset_id),
          listingPrice: String(sale.listing_price),
          price: Number(sale.price.amount) / 1e8,
          seller: sale.seller,
          asset: makeAssetRef(String(a.asset_id), c, statsMap, templates.data!),
          templateId: c.t,
          schema: c.s,
          kind: blendInput ? null : kind
        })
      }
      return out.sort((x, y) => x.price - y.price)
    }
  })
}

// ---- Alcor pools ------------------------------------------------------------------------------------

export interface SwapPools {
  /** DEF / WAX: DEF for Forge slots, and the DEF side of swaps. */
  def: Pool
  /** TLM / WAX: TLM for Forge levels, and the TLM side of swaps. */
  tlm: Pool
  /** TLM / DEF: the direct route between the two game tokens. */
  tlmdef: Pool
}

async function fetchPool(id: number): Promise<Pool> {
  const row = await getRow<Parameters<typeof poolFromRow>[1]>({
    code: CONTRACTS.ALCOR_SWAP,
    table: 'pools',
    lower_bound: id,
    upper_bound: id
  })
  if (!row) throw new Error(`Alcor pool ${id} missing`)
  return poolFromRow(id, row)
}

/** The three Alcor pools between WAX, TLM and DEF, read live with price, fee and depth. */
export function useSwapPools(): UseQueryResult<SwapPools> {
  return useQuery({
    queryKey: ['swap-pools'],
    queryFn: async () => {
      const [def, tlm, tlmdef] = await Promise.all([
        fetchPool(ALCOR_DEF_WAX_POOL_ID),
        fetchPool(ALCOR_TLM_WAX_POOL_ID),
        fetchPool(ALCOR_TLM_DEF_POOL_ID)
      ])
      return { def, tlm, tlmdef }
    },
    staleTime: 30_000,
    refetchInterval: 60_000
  })
}
