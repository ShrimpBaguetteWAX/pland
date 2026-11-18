import { atomic } from '@/chain/atomic'
import { CONTRACTS } from '@/chain/config'
import { getRows } from '@/chain/rpc'

/*
 * NFTs the account has offered away, read from the chain. A listing on AtomicMarket is an
 * AtomicAssets offer from the seller to atomicmarket, so this is the one up-to-date answer to
 * "which of my NFTs are listed": the AtomicMarket API lags behind a fresh listing and is read page
 * by page from nodes that may disagree. Listing an NFT that is already offered fails.
 *
 * A node gives at most 1,000 rows a read, and every offer of one sender has the same key on the
 * sender index, so the index cannot be paged past them. So: the oldest 1,000 and the newest 1,000
 * from the chain (the newest are the ones the API may not have yet), and, for an account with more
 * than that, everything in between from the AtomicAssets API (older, so the API has it).
 */
const CHAIN_READ = 1000

interface OfferRow {
  offer_id: string | number
  sender: string
  recipient: string
  sender_asset_ids: (string | number)[]
}

/** Every asset id in an open offer the account sent (listings and trade offers alike). */
export async function offeredAssetIds(account: string): Promise<Set<string>> {
  const read = (reverse: boolean) =>
    getRows<OfferRow>({
      code: CONTRACTS.ATOMICASSETS,
      scope: CONTRACTS.ATOMICASSETS,
      table: 'offers',
      index_position: 2,
      key_type: 'name',
      lower_bound: account,
      upper_bound: account,
      limit: CHAIN_READ,
      reverse
    })
  const [oldest, newest] = await Promise.all([read(false), read(true)])
  const ids = new Set([...oldest, ...newest].filter((r) => r.sender === account).flatMap((r) => r.sender_asset_ids.map(String)))
  if (oldest.length >= CHAIN_READ) {
    // More than one read holds: the ones in between from the API. Without it, what the chain gave.
    const middle = await atomic.getOpenOfferAssetIds(account).catch(() => null)
    for (const id of middle ?? []) ids.add(id)
  }
  return ids
}
