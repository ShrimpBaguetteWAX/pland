import type { AnyAction } from '@wharfkit/session'

import { CONTRACTS } from '@/chain/config'

/*
 * Action builders for the Planetary Defense contracts. Every action is signed by the player alone;
 * the contracts check slots, cooldowns and requirements themselves.
 */

const auth = (account: string, permission: string) => [{ actor: account, permission }]

const action = (
  contract: string,
  name: string,
  account: string,
  permission: string,
  data: Record<string, unknown>
): AnyAction => ({
  account: contract,
  name,
  authorization: auth(account, permission),
  data
})

// ---- core.pdef: player, staking, divisions, units --------------------------------------------

/** First-time players are registered in the same transaction as their first action. */
export const regPlayer = (a: string, p: string) => action(CONTRACTS.CORE, 'regplayer', a, p, { owner: a })

/** Moves NFTs into the game: an AtomicAssets transfer to core.pdef with memo "stake". */
export const stakeAssets = (a: string, p: string, assetIds: string[]) =>
  action(CONTRACTS.ATOMICASSETS, 'transfer', a, p, { from: a, to: CONTRACTS.CORE, asset_ids: assetIds, memo: 'stake' })

export const unstakeAsset = (a: string, p: string, assetId: string) =>
  action(CONTRACTS.CORE, 'unstake', a, p, { owner: a, asset_id: assetId })

export const createDivision = (a: string, p: string, leaderAssetId: string) =>
  action(CONTRACTS.CORE, 'creatediv', a, p, { owner: a, leader_asset_id: leaderAssetId })

/** Removes a division by its warlord; the contract refuses while mercenaries are still in it. */
export const deleteDivision = (a: string, p: string, leaderAssetId: string) =>
  action(CONTRACTS.CORE, 'deldvasset', a, p, { owner: a, leader_asset_id: leaderAssetId })

export const addUnit = (a: string, p: string, divisionId: number, unitAssetId: string) =>
  action(CONTRACTS.CORE, 'addunit', a, p, { owner: a, division_id: divisionId, unit_asset_id: unitAssetId })

export const removeUnit = (a: string, p: string, unitAssetId: string) =>
  action(CONTRACTS.CORE, 'removeunit', a, p, { owner: a, unit_asset_id: unitAssetId })

export type GearKind = 'weapon' | 'supply' | 'creature' | 'lavalux'

/** Attaches one piece of gear to a mercenary; the other slots are passed as 0 (unchanged). */
export const assignGear = (a: string, p: string, divisionId: number, unitAssetId: string, kind: GearKind, gearAssetId: string) =>
  action(CONTRACTS.CORE, 'assign', a, p, {
    owner: a,
    division_id: divisionId,
    unit_asset_id: unitAssetId,
    creature_asset_id: kind === 'creature' ? gearAssetId : 0,
    weapon_asset_id: kind === 'weapon' ? gearAssetId : 0,
    supply_asset_id: kind === 'supply' ? gearAssetId : 0,
    lavalux_asset_id: kind === 'lavalux' ? gearAssetId : 0
  })

export const unassignGear = (a: string, p: string, divisionId: number, unitAssetId: string, gearAssetId: string) =>
  action(CONTRACTS.CORE, 'unassign', a, p, {
    owner: a,
    division_id: divisionId,
    unit_asset_id: unitAssetId,
    gear_asset_id: gearAssetId
  })

/** Recomputes a division's cached stats; a join needs a fresh cache for the current stats epoch. */
export const recalcDivision = (a: string, p: string, divisionId: number) =>
  action(CONTRACTS.CORE, 'calcdiv', a, p, { owner: a, division_id: divisionId })

// ---- miss.pdef: missions -------------------------------------------------------------------------

export interface EntryCost {
  contract: string
  quantity: string
}

/** Pays one division's entry: a token transfer to miss.pdef with memo "entry:<mission>". */
export const payEntry = (a: string, p: string, missionId: number, cost: EntryCost) =>
  action(cost.contract, 'transfer', a, p, {
    from: a,
    to: CONTRACTS.MISSIONS,
    quantity: cost.quantity,
    memo: `entry:${missionId}`
  })

export const joinMission = (a: string, p: string, missionId: number, divisionIds: number[]) =>
  action(CONTRACTS.MISSIONS, 'join', a, p, { owner: a, mission_id: missionId, division_ids: divisionIds })

export const claimMission = (a: string, p: string, missionId: number, divisionId: number) =>
  action(CONTRACTS.MISSIONS, 'claim', a, p, { owner: a, mission_id: missionId, division_id: divisionId })

/**
 * Everything one division's deployment needs, in order: its entry fee, a recalculation when its
 * stats cache is stale, then the join. The contract takes one division per join ("You need to
 * deploy one division at a time"), and a transaction may hold only one join, so a deployment of
 * several divisions is one of these per division, signed one after another (see deployParts).
 */
export function deployActions(
  a: string,
  p: string,
  missionId: number,
  divisionId: number,
  stale: boolean,
  costs: EntryCost[]
): AnyAction[] {
  return [
    ...costs.map((cost) => payEntry(a, p, missionId, cost)),
    ...(stale ? [recalcDivision(a, p, divisionId)] : []),
    joinMission(a, p, missionId, [divisionId])
  ]
}

/** One transaction per division: the actions of each, with the division it is for. */
export function deployParts(
  a: string,
  p: string,
  deployments: { missionId: number; divisionId: number; stale: boolean; costs: EntryCost[] }[]
): { divisionId: number; missionId: number; actions: AnyAction[] }[] {
  return deployments.map((d) => ({
    divisionId: d.divisionId,
    missionId: d.missionId,
    actions: deployActions(a, p, d.missionId, d.divisionId, d.stale, d.costs)
  }))
}

// ---- forge.pdef ----------------------------------------------------------------------------------

/** Pays (part of) the next forge level: TLM to forge.pdef with memo "forge:<level>". */
export const payForgeLevel = (a: string, p: string, level: number, quantity: string, tokenContract: string) =>
  action(tokenContract, 'transfer', a, p, { from: a, to: CONTRACTS.FORGE, quantity, memo: `forge:${level}` })

/** Buys a shop item (a slot): its price to forge.pdef with memo "shop:<item>". */
export const buyShopItem = (a: string, p: string, itemId: number, price: string, priceContract: string) =>
  action(priceContract, 'transfer', a, p, { from: a, to: CONTRACTS.FORGE, quantity: price, memo: `shop:${itemId}` })

// ---- core.pdef: the game balance -------------------------------------------------------------------

/** Adds to the game balance core.pdef holds for the player: a token transfer with the memo "deposit". */
export const depositAction = (a: string, p: string, contract: string, quantity: string) =>
  action(contract, 'transfer', a, p, { from: a, to: CONTRACTS.CORE, quantity, memo: 'deposit' })

/** Sends part of the game balance back to the wallet. */
export const withdrawBalanceAction = (a: string, p: string, quantity: string) =>
  action(CONTRACTS.CORE, 'withdrawbal', a, p, { owner: a, quantity })
