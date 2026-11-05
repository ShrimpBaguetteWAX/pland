import type { AnyAction } from '@wharfkit/session'

import { CONTRACTS } from '@/chain/config'

/*
 * Ascension lives on ascend.pdef and is driven by NFT transfers (seen on chain):
 *
 *  - Sacrifice: transfer cards to ascend.pdef with memo "burn". The contract records a request
 *    (table pendingburns) and the game's oracle reveals it a few seconds later: the cards are
 *    burned and the Fragments are minted to the player (guaranteed ones plus a bonus by chance).
 *  - Ascend: transfer one card plus exactly the Fragments its next star costs with memo "ascend".
 *    The card and the Fragments are burned and the next tier of the same card is minted at once.
 */

const auth = (account: string, permission: string) => [{ actor: account, permission }]

/** Burns cards for Fragments (the Sacrificial Altar). */
export const sacrificeAction = (account: string, permission: string, assetIds: string[]): AnyAction => ({
  account: CONTRACTS.ATOMICASSETS,
  name: 'transfer',
  authorization: auth(account, permission),
  data: { from: account, to: CONTRACTS.ASCEND, asset_ids: assetIds, memo: 'burn' }
})

/** Raises one card a star (the Ascend Nexus): the card and its Fragments go together. */
export const ascendAction = (
  account: string,
  permission: string,
  cardAssetId: string,
  fragmentAssetIds: string[]
): AnyAction => ({
  account: CONTRACTS.ATOMICASSETS,
  name: 'transfer',
  authorization: auth(account, permission),
  data: { from: account, to: CONTRACTS.ASCEND, asset_ids: [cardAssetId, ...fragmentAssetIds], memo: 'ascend' }
})
