import type { AnyAction } from '@wharfkit/session'

import { CONTRACTS } from '@/chain/config'

/*
 * Planetary sieges (siege.pdef). A world is funded with DEF sent to the siege contract with the
 * memo "unlock:<planet id>" (final: the DEF is never returned). Once a season is open, a division
 * joins through `joindiv`; its TLM entry fee is taken from the player's balance held by core.pdef
 * (topped up by a TLM transfer with the memo "deposit"), never by a transfer to the siege itself,
 * which would go to the treasury. After the cooldown the entry is claimed with `claimdiv`.
 */

const auth = (account: string, permission: string) => [{ actor: account, permission }]

export const contributeDefAction = (account: string, permission: string, planetId: number, def: number): AnyAction => ({
  account: CONTRACTS.DEF,
  name: 'transfer',
  authorization: auth(account, permission),
  data: { from: account, to: CONTRACTS.SIEGE, quantity: `${def.toFixed(8)} DEF`, memo: `unlock:${planetId}` }
})

/** Tops up the TLM balance core.pdef holds for the player, which siege entries are paid from. */
export const depositTlmAction = (account: string, permission: string, tlm: number): AnyAction => ({
  account: CONTRACTS.TLM,
  name: 'transfer',
  authorization: auth(account, permission),
  data: { from: account, to: CONTRACTS.CORE, quantity: `${tlm.toFixed(4)} TLM`, memo: 'deposit' }
})

export const joinSiegeAction = (account: string, permission: string, planetId: number, divisionId: number): AnyAction => ({
  account: CONTRACTS.SIEGE,
  name: 'joindiv',
  authorization: auth(account, permission),
  data: { owner: account, planet_id: planetId, division_id: divisionId }
})

export const claimSiegeAction = (account: string, permission: string, planetId: number, entryId: number): AnyAction => ({
  account: CONTRACTS.SIEGE,
  name: 'claimdiv',
  authorization: auth(account, permission),
  data: { owner: account, planet_id: planetId, entry_id: entryId }
})
