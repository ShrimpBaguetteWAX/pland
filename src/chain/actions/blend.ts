import type { AnyAction } from '@wharfkit/session'

import { CONTRACTS } from '@/chain/config'
import { BLEND_CONTRACT } from '@/data/blends'

export interface BlendRun {
  blendId: number
  /** The NFTs this run burns, in the order of the recipe's ingredients. */
  assetIds: string[]
}

/**
 * Runs blends the way NeftyBlocks' own sites do: announce how many NFTs are coming, deposit them
 * all in one transfer, then one no-security fuse per blend with its share of the deposit. The
 * result is minted a few seconds later, once the random number oracle has answered.
 */
export function blendActions(account: string, permission: string, runs: BlendRun[]): AnyAction[] {
  const auth = [{ actor: account, permission }]
  const all = runs.flatMap((r) => r.assetIds)
  if (!all.length) return []
  return [
    { account: BLEND_CONTRACT, name: 'announcedepo', authorization: auth, data: { owner: account, count: all.length } },
    {
      account: CONTRACTS.ATOMICASSETS,
      name: 'transfer',
      authorization: auth,
      data: { from: account, to: BLEND_CONTRACT, asset_ids: all, memo: 'deposit' }
    },
    ...runs.map((r): AnyAction => ({
      account: BLEND_CONTRACT,
      name: 'nosecfuse',
      authorization: auth,
      data: { claimer: account, blend_id: r.blendId, transferred_assets: r.assetIds, own_assets: [] }
    }))
  ]
}
