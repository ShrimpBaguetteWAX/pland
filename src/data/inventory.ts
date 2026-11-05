import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { atomic } from '@/chain/atomic'
import { kindOfCategory, type Kind } from '@/lib/stats'

import { cachedOf, makeAssetRef, type AssetRef } from './assets'
import { useAssetStats, useTemplates } from './game'
import { queryClient } from './queryClient'

/*
 * The player's wallet, every NFT of the collection: the playable ones with their game stats, and
 * the materials and loot (Quantum Chests and Keys) the blends use. For the Market's inventory.
 */

const COLLECTION = 'planetdefnft'

export type InventoryKind = Kind | 'material' | 'loot'

export interface InventoryItem {
  asset: AssetRef
  kind: InventoryKind
}

export const INVENTORY_KINDS: InventoryKind[] = [
  'warlord',
  'mercenary',
  'weapon',
  'supply',
  'creature',
  'lavalux',
  'material',
  'loot'
]

export const INVENTORY_LABEL: Record<InventoryKind, string> = {
  warlord: 'Warlords',
  mercenary: 'Mercenaries',
  weapon: 'Equipment',
  supply: 'Supplies',
  creature: 'Creatures',
  lavalux: 'Lava Lux',
  material: 'Materials',
  loot: 'Chests & keys'
}

export function useInventory(account: string | null): UseQueryResult<InventoryItem[]> {
  const stats = useAssetStats()
  const templates = useTemplates()
  return useQuery({
    queryKey: ['inventory', account],
    enabled: !!account && stats.isSuccess && templates.isSuccess,
    staleTime: 60_000,
    queryFn: async () => {
      const assets = await atomic.getOwnedAssets(account!, COLLECTION)
      const out: InventoryItem[] = []
      for (const a of assets) {
        const c = cachedOf(a)
        if (!c) continue
        const ref = makeAssetRef(String(a.asset_id), c, stats.data!, templates.data!)
        const kind: InventoryKind | null =
          c.s === 'material' ? 'material' : c.s === 'loot' ? 'loot' : kindOfCategory(ref.stats?.category)
        if (!kind) continue
        // Loot and materials carry no stats template: the collection's own data names them.
        if (!ref.info) ref.rarity = String(a.data.rarity ?? '').toLowerCase()
        out.push({ asset: ref, kind })
      }
      return out
    }
  })
}

export interface OwnListing {
  saleId: string
  assetId: string
  /** WAX. */
  price: number
}

/** The player's own WAX listings on AtomicMarket, so listed NFTs are not offered again. */
export function useOwnListings(account: string | null): UseQueryResult<OwnListing[]> {
  return useQuery({
    queryKey: ['own-listings', account],
    enabled: !!account,
    staleTime: 60_000,
    queryFn: async () => {
      const sales = await atomic.getSales({ seller: account!, collection_name: COLLECTION })
      return sales
        .filter((s) => s.assets.length === 1 && s.listing_symbol === 'WAX')
        .map((s) => ({ saleId: String(s.sale_id), assetId: String(s.assets[0].asset_id), price: Number(s.price.amount) / 1e8 }))
    }
  })
}

/** After listing, cancelling or buying: the wallet and the listings again. */
export function refreshInventory(account: string | null) {
  return Promise.all(
    [
      ['inventory', account],
      ['own-listings', account],
      ['market-listings'],
      ['wallet-nfts', account],
      ['owned-blend-inputs', account]
    ].map((queryKey) => queryClient.invalidateQueries({ queryKey }))
  )
}
