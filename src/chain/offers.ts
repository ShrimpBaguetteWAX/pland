import { CONTRACTS } from '@/chain/config'
import { getRows } from '@/chain/rpc'

/*
 * NFTs the account has offered away, read from the chain. A listing on AtomicMarket is an
 * AtomicAssets offer from the seller to atomicmarket, so this is the one up-to-date answer to
 * "which of my NFTs are listed": the AtomicMarket API lags behind a fresh listing and is read page
 * by page from nodes that may disagree. Listing an NFT that is already offered fails.
 */

interface OfferRow {
  offer_id: string | number
  sender: string
  recipient: string
  sender_asset_ids: (string | number)[]
}

/** Every asset id in an open offer the account sent (listings and trade offers alike). */
export async function offeredAssetIds(account: string): Promise<Set<string>> {
  const rows = await getRows<OfferRow>({
    code: CONTRACTS.ATOMICASSETS,
    scope: CONTRACTS.ATOMICASSETS,
    table: 'offers',
    index_position: 2,
    key_type: 'name',
    lower_bound: account,
    upper_bound: account
  })
  return new Set(rows.filter((r) => r.sender === account).flatMap((r) => r.sender_asset_ids.map(String)))
}
